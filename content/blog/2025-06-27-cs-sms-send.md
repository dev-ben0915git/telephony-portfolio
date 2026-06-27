---
title: "Android CS 短信发送全流程分析"
date: "2025-06-27"
summary: "从 Messaging 应用调用 SmsManager.sendMultipartTextMessage 到 Modem 完成无线侧发送的完整 CS 域短信发送链路分析，涵盖 IMS/CS 路由决策、PDU 构造、SmsTracker 生命周期管理与送达报告处理。"
category: "sms"
tags: ["SmsManager", "SmsDispatcher", "GsmSMSDispatcher", "SmsDispatchersController", "IccSmsInterfaceManager", "SmsController", "SmsTracker", "RIL_REQUEST_SEND_SMS", "PDU", "DeliveryReport", "MultipartSMS"]
featured: true
---

---
## 第 1 章 概述

### 1.1 CS 短信发送在 Android Telephony 中的位置

Android 短信发送体系横跨应用层、Framework 服务层、RIL（Radio Interface Layer）以及 Modem 固件四个层级。CS（Circuit Switched，电路交换）短信是指通过传统语音信道承载的 SMS 服务，与 IMS（IP Multimedia Subsystem）域的 SMS over IP 形成互补。在 VoLTE/VoNR 尚未全面普及的场景下，CS 短信仍是终端最基础的短消息传输手段。

Framework 层的短信发送核心代码位于 `packages/services/Telephony/` 与 `frameworks/base/telephony/` 两个目录下。前者运行在 `com.android.phone` 进程中，作为 Telephony 服务的具体实现；后者提供供第三方应用调用的公共 API，典型入口为 `android.telephony.SmsManager`。

### 1.2 整体流程总览

从 Messaging 应用调用 `SmsManager.sendMultipartTextMessage` 到最终 Modem 完成无线侧发送，完整流程可归纳为 8 个关键步骤：

| 步骤 | 层级 | 关键类/方法 | 职责 |
|------|------|------------|------|
| 1 | 应用层 / Framework API | `SmsManager.sendMultipartTextMessage` | 拆分长短信，发起跨进程调用 |
| 2 | Framework 服务 | `SmsController.sendTextForSubscriber` | 权限校验，按 subId 路由 |
| 3 | Framework 服务 | `IccSmsInterfaceManager.sendText` | SIM 卡短信接口代理转发 |
| 4 | Framework 服务 | `SmsDispatchersController.sendText` | **IMS/CS 分界点**，决策发送域 |
| 5 | Framework 服务 | `SMSDispatcher.sendText` / `sendSubmitPdu` / `sendRawPdu` | 构造 PDU，创建 SmsTracker |
| 6 | Framework 服务 | `GsmSMSDispatcher.sendSms` | 生成 `RIL_REQUEST_SEND_SMS` |
| 7 | Framework 服务 / RIL | `handleSendComplete` | 解析 Modem 响应，回调 `mSentIntent` |
| 8 | Framework 服务 / RIL | `triggerDeliveryIntent` | 处理送达报告，回调 `mDeliveryIntent` |

### 1.3 CS 域与 IMS 域发送的异同与选择策略

Android 在 `SmsDispatchersController` 中实现 IMS 与 CS 的动态选择。当终端成功注册 IMS 且网络支持 SMS over IMS 时，短信优先走 IMS 通道（`ImsSmsDispatcher` -> `RIL_REQUEST_IMS_SEND_SMS`）；否则回落到 CS 域（`GsmSMSDispatcher` / `CdmaSMSDispatcher` -> `RIL_REQUEST_SEND_SMS`）。

本文以 **CS 域的 GSM 路径** 为主线进行说明，IMS 相关逻辑仅在分界点处作为对比提及。

### 1.4 关键术语解释

| 术语 | 说明 |
|------|------|
| PDU | Protocol Data Unit，短信协议数据单元，包含 SMSC 地址、目标号码、编码方式、用户数据等 |
| SMSC | Short Message Service Center，短信服务中心，负责短信的存储与转发 |
| TP-MR | Transport Protocol Message Reference，短信传输层消息参考号，用于唯一标识一条短信发送事务 |
| Delivery Report | 送达报告，网络侧在短信成功投递到接收方终端后返回的状态通知 |
| Concat-Ref | Concatenation Reference，长短信拆分后的重组参考号，用于接收端合并多段短信 |

---

## 第 2 章 关键类与数据结构

### 2.1 SmsManager：应用层 API 入口

`android.telephony.SmsManager` 是第三方应用发送短信的唯一官方入口。其核心方法族包括：

- `sendTextMessage`：发送单条文本短信
- `sendMultipartTextMessage`：发送多部分（长）短信
- `sendDataMessage`：发送数据短信

以 `sendMultipartTextMessage` 为例，该方法首先调用 `divideMessage` 将超出单条长度限制的文本拆分为多个片段，随后进入内部方法 `sendMultipartTextMessageInternal`。在内部方法中，对每个片段循环调用 `sendTextMessageInternal`，而 `sendTextMessageInternal` 最终通过 `ISms` AIDL 接口完成跨进程调用：

```
SmsManager (应用进程)
  -> ISms.sendTextForSubscriber(...)  // 跨进程调用 phone 进程
```

`ISms` 接口定义在 `com.android.internal.telephony.ISms.aidl` 中，其实现类为 `SmsController`。

### 2.2 SmsController：ISmsImplBase 的服务端实现

`SmsController` 继承自 `ISmsImplBase`，运行在 `com.android.phone` 进程中，负责承接所有来自应用层的短信发送请求。其核心方法 `sendTextForSubscriber` 的主要工作包括：

1. 根据传入的 `subId` 获取对应 SIM 卡的 `IccSmsInterfaceManager`
2. 检查调用方是否持有 `SEND_SMS` 权限及 `AppOps` 权限
3. 将请求转发给 `IccSmsInterfaceManager.sendText`

对于 `sendMultipartTextMessage` 的调用链路，`SmsController` 中的 `sendMultipartTextForSubscriber` 会将多部分短信按片段逐条下发，行为上与多次单条发送类似。

### 2.3 IccSmsInterfaceManager：SIM 卡短信接口代理

`IccSmsInterfaceManager` 是 SIM 卡级别的短信管理器，每个 `Phone` 实例对应一个 `IccSmsInterfaceManager`。它负责将上层请求继续转发给 `SmsDispatchersController`，同时处理与 SIM 卡存储相关的短信操作（如读取/删除 SIM 卡中的短信）。

在发送路径中，`IccSmsInterfaceManager.sendText` / `sendTextInternal` 仅做简单的参数封装与合法性校验，随后将调用传递至 `SmsDispatchersController`。

### 2.4 SmsDispatchersController：IMS/CS 路由决策中心

`SmsDispatchersController` 是整个短信发送流程中的关键分水岭。它维护对 `ImsSmsDispatcher`、`GsmSMSDispatcher` 和 `CdmaSMSDispatcher` 的引用，并在 `sendText` / `sendTextInternal` 中执行路由决策。

路由判断的核心逻辑通常包括：

1. 查询 IMS 是否注册（`ImsManager.isServiceAvailable`）
2. 检查当前网络是否支持 SMS over IMS
3. 若满足 IMS 条件，则委托 `ImsSmsDispatcher` 处理
4. 否则根据当前网络类型选择 `GsmSMSDispatcher`（GSM/UMTS/LTE/NR）或 `CdmaSMSDispatcher`（CDMA/EVDO）

由于本文聚焦 CS 路径，后续章节将以 `GsmSMSDispatcher` 为主视角展开。

### 2.5 SMSDispatcher：短信发送抽象框架

`SMSDispatcher` 是 CS 域短信发送的抽象基类，定义了短信发送的通用骨架。核心方法链如下：

| 方法 | 说明 |
|------|------|
| `sendText` | 入口方法，准备参数并创建 `SmsTracker` |
| `sendSubmitPdu` | 构造提交用的 PDU |
| `sendRawPdu` | 对 PDU 进行最终校验与封装 |
| `sendSms` | 抽象方法，由子类实现具体的 RIL 请求构造 |

`SMSDispatcher` 同时管理 `mSmsTrackerMap`（以 `mMessageRef` 为 Key 的 `SmsTracker` 映射表），用于追踪已发送短信的状态，并在 Modem 返回结果或送达报告时进行匹配。

### 2.6 GsmSMSDispatcher：GSM CS 短信发送实现

`GsmSMSDispatcher` 继承自 `SMSDispatcher`，专责 GSM 制式下的短信发送。其关键特征包括：

- 使用 `FORMAT_3GPP` 标识 3GPP 规范定义的 PDU 格式
- 重写 `sendSms` 方法，通过 `CommandsInterface.sendSMS()` 向 RIL 发起 `RIL_REQUEST_SEND_SMS`
- 在构造函数中注册 `mCi.setOnSmsStatus(this, EVENT_NEW_SMS_STATUS_REPORT, null)`，用于监听送达报告

对于多部分短信，除最后一段外，其余片段使用 `RIL_REQUEST_SEND_SMS_EXPECT_MORE` 替代 `RIL_REQUEST_SEND_SMS`，告知 Modem 后续还有更多片段，以便 Modem 优化无线资源分配。

### 2.7 CdmaSMSDispatcher 与 ImsSmsDispatcher 简要对比

| 特性 | `GsmSMSDispatcher` | `CdmaSMSDispatcher` | `ImsSmsDispatcher` |
|------|---------------------|----------------------|---------------------|
| 继承父类 | `SMSDispatcher` | `SMSDispatcher` | 独立实现 |
| PDU 格式 | `FORMAT_3GPP` | `FORMAT_3GPP2` | 取决于底层 IMS 配置 |
| RIL 请求 | `RIL_REQUEST_SEND_SMS` | `RIL_REQUEST_SEND_SMS`（CDMA 专用封装） | `RIL_REQUEST_IMS_SEND_SMS` |
| 适用网络 | GSM/UMTS/LTE/NR | CDMA/EVDO | IMS 注册网络 |

### 2.8 SmsTracker 详解

`SmsTracker` 是 `SMSDispatcher` 的内部类，用于追踪单条短信的完整生命周期。其核心字段包括：

| 字段 | 类型 | 说明 |
|------|------|------|
| `mMessageRef` | `int` | TP-MR，消息参考号，匹配发送请求与响应 |
| `mRetryCount` | `int` | 当前重试次数，超过阈值后标记为失败 |
| `mSentIntent` | `PendingIntent` | 发送结果回调，成功/失败均触发 |
| `mDeliveryIntent` | `PendingIntent` | 送达报告回调，仅在用户开启且网络支持时触发 |
| `mPdu` | `byte[]` | 待发送的 PDU 数据 |
| `mSmsHeader` | `SmsHeader` | 多部分短信的头部信息（Concat-Ref 等） |

`SmsTracker` 提供 `onSent()` 和 `onFailed()` 两个核心回调方法，分别在发送成功和失败时被调用，内部通过 `PendingIntent.send()` 将结果广播给应用层。

---

## 第 3 章 RIL 消息交互

### 3.1 RIL_REQUEST_SEND_SMS：CS 域短信发送请求

`RIL_REQUEST_SEND_SMS` 是 Framework 向 Modem 请求发送 CS 短信的标准 RIL 消息。请求参数包含两个 `byte[]`：

- `smscPDU`：SMSC 地址的 PDU 编码，若为空则使用 SIM 卡中预置的 SMSC
- `pdu`：完整的短信 PDU，包含目标地址、用户数据、协议标识等

Framework 侧通过 `CommandsInterface.sendSMS()` 发起该请求，RIL 层将其转换为 AT 命令（如 GSM 的 `AT+CMGS`）下发给 Modem。

### 3.2 RIL_REQUEST_SEND_SMS_EXPECT_MORE：多部分短信优化

该请求与 `RIL_REQUEST_SEND_SMS` 结构完全相同，仅在功能语义上存在差异：告知 Modem 当前短信片段后还有后续片段，请求 Modem 保持无线信道状态，避免频繁建立/释放连接带来的时延与功耗开销。

在多部分短信发送中，除最后一段外，其余片段均使用此请求。最终片段仍使用 `RIL_REQUEST_SEND_SMS`，通知 Modem 可以关闭相关资源。

### 3.3 RIL_REQUEST_IMS_SEND_SMS：IMS 域发送（简要对比）

当 `SmsDispatchersController` 判定走 IMS 路径时，`ImsSmsDispatcher` 通过此 RIL 请求将短信交由 IMS 栈处理。请求参数与 CS 域类似，但 Modem 侧会将短信封装为 SIP MESSAGE 而非传统 SMS PDU，通过 P-CSCF 路由至 SMSC。

### 3.4 RIL_UNSOL_RESPONSE_NEW_SMS_STATUS_REPORT：送达报告上报

这是一条从 Modem 上报到 Framework 的**非请求响应**（Unsolicited Response）。当网络侧返回短信送达状态报告时，Modem 通过此消息将报告内容上报。上报数据通常包含：

- 原始短信的 TP-MR（`messageRef`）
- 送达状态（成功/失败/待确认）
- 可选的时间戳与网络原因码

Framework 侧在 `GsmSMSDispatcher` / `SMSDispatcher` 中解析该消息，提取 `messageRef` 后在 `mSmsTrackerMap` 中匹配对应的 `SmsTracker`，进而触发 `triggerDeliveryIntent()`。

---

## 第 4 章 应用层到 SmsDispatchersController（步骤 1-4）

### 4.1 步骤 1：应用调用 SmsManager.sendMultipartTextMessage

当用户在 Messaging 应用中编辑一条超出单条 GSM 短信长度限制（7-bit 编码下 160 字符，UCS-2 编码下 70 字符）的文本并点击发送时，应用调用 `SmsManager.sendMultipartTextMessage`。该方法内部首先执行消息拆分：

```
sendMultipartTextMessage(destAddr, scAddr, parts, sentIntents, deliveryIntents)
  -> divideMessage(text)  // 将长文本拆分为 ArrayList<String>
  -> sendMultipartTextMessageInternal(...)
    -> 对每个片段循环调用 sendTextMessageInternal(...)
```

`divideMessage` 的实现依据当前编码方式动态计算单条容量：若文本全部落在 GSM 7-bit 字母表内，则按 160/153（头部开销后）字符分段；若包含非 7-bit 字符，则按 70/67 字符分段。每个片段在后续流程中都被视为独立的短信发送请求。

### 4.2 步骤 2：SmsController#sendTextForSubscriber -> sendIccText

`sendTextMessageInternal` 在应用进程侧通过 `ISms` AIDL 接口将请求传递至 `com.android.phone` 进程。服务端入口为 `SmsController.sendTextForSubscriber`，其典型处理逻辑如下：

1. 根据 `subId` 从 `PhoneFactory` 中获取对应的 `Phone` 实例
2. 从 `Phone` 实例中获取 `IccSmsInterfaceManager`
3. 执行权限检查：`SEND_SMS` Manifest 权限 + `AppOpsManager.OP_SEND_SMS` 运行时权限
4. 若权限通过，调用 `IccSmsInterfaceManager.sendText`

`SmsController` 作为 `ISms.Stub` 的实现者，是所有应用层短信请求的集中处理点，承担权限 gatekeeper 的角色。

### 4.3 步骤 3：IccSmsInterfaceManager#sendText / sendTextInternal

`IccSmsInterfaceManager` 接收到请求后，将参数重新封装并转发给 `SmsDispatchersController`。此层级的转发逻辑较为直接，主要完成以下工作：

1. 检查当前 SIM 卡是否就绪（`mPhone.getIccRecords()` 非空）
2. 将 `destAddr`、`scAddr`、`text`、`sentIntent`、`deliveryIntent` 等参数原样传递
3. 调用 `SmsDispatchersController.sendText`

`IccSmsInterfaceManager` 的设计初衷是屏蔽不同 UICC 卡类型（USIM、RUIM、CSIM 等）的差异，为上层提供统一的短信操作接口。

### 4.4 步骤 4：SmsDispatchersController#sendText / sendTextInternal — IMS/CS 分界点

`SmsDispatchersController` 是整个发送链路中最关键的决策节点。其 `sendText` 方法的核心逻辑可概括为：

```
sendText(...)
  -> 检查 IMS 是否可用且支持 SMS over IMS
       -> 是：调用 ImsSmsDispatcher.sendText(...)
       -> 否：继续检查网络类型
            -> GSM/UMTS/LTE/NR：调用 GsmSMSDispatcher.sendText(...)
            -> CDMA/EVDO：调用 CdmaSMSDispatcher.sendText(...)
```

IMS 可用性的判断依据通常包括：

- `ImsMmTelManager` 报告 IMS 注册状态为 `REGISTRATION_STATE_REGISTERED`
- `MmTelFeature` 的 `SMS` 能力位已开启
- 当前未处于飞行模式或 CSFB 强制回落场景

**本文以 CS 路径为主线**，假设上述 IMS 条件不满足，请求被路由至 `GsmSMSDispatcher.sendText(...)`，进入 `SMSDispatcher` 的抽象处理流程。

---

## 第 5 章 SMSDispatcher 与 GsmSMSDispatcher 发送链路（步骤 5-6）

### 5.1 步骤 5：SMSDispatcher#sendText / sendSubmitPdu / sendRawPdu / sendSms

`GsmSMSDispatcher.sendText` 实际调用的是继承自 `SMSDispatcher` 的 `sendText` 方法。该方法完成以下核心工作：

**（1）PDU 构造**

根据目标地址、短信中心地址、文本内容和编码方式，调用 `SmsMessage.getSubmitPdu` 构造 3GPP 规范的 Submit PDU。该 PDU 包含：

- TP-MTI（Message Type Indicator）：设置为 01（SMS-SUBMIT）
- TP-RD（Reject Duplicates）：通常设置为 0
- TP-VPF（Validity Period Format）：根据需要设置
- TP-SRR（Status Report Request）：若用户开启送达报告，设置为 1
- TP-MR（Message Reference）：由 `SmsDispatcher` 分配递增序号
- TP-DA（Destination Address）：目标手机号码
- TP-PID（Protocol Identifier）：默认 0x00
- TP-DCS（Data Coding Scheme）：7-bit / 8-bit / UCS-2
- TP-VP（Validity Period）：短信有效期
- TP-UDL（User Data Length）/ TP-UD（User Data）：用户文本数据

**（2）SmsTracker 创建与注册**

将 PDU、`sentIntent`、`deliveryIntent` 等数据封装为 `SmsTracker` 对象，并以 TP-MR 为 Key 存入 `mSmsTrackerMap`：

```java
SmsTracker tracker = new SmsTracker(...);
mSmsTrackerMap.put(tracker.mMessageRef, tracker);
```

**（3）方法链流转**

```
SMSDispatcher.sendText(...)
  -> sendSubmitPdu(submitPdu, ...)
    -> sendRawPdu(smsc, pdu, ...)
      -> sendSms(tracker)  // 抽象方法，由子类实现
```

`sendRawPdu` 在调用 `sendSms` 之前还会执行最终校验，如检查 PDU 长度是否超出限制、SMSC 地址是否合法等。

### 5.2 步骤 6：GsmSMSDispatcher#sendSms

`GsmSMSDispatcher` 重写 `sendSms` 方法，完成从 Framework 对象到 RIL 请求的转换：

```java
@Override
protected void sendSms(SmsTracker tracker) {
    byte[] pdu = tracker.mPdu;
    byte[] smsc = tracker.mSmsc;
    
    // 对于多部分短信的非最后一段，使用 EXPECT_MORE
    int rilRequest = tracker.mExpectMore 
        ? RIL_REQUEST_SEND_SMS_EXPECT_MORE 
        : RIL_REQUEST_SEND_SMS;
    
    mCi.sendSMS(smsc, pdu, 
        obtainMessage(EVENT_SEND_SMS_COMPLETE, tracker));
}
```

`mCi` 为 `CommandsInterface` 实例，代表与 RIL 层的通信通道。`obtainMessage(EVENT_SEND_SMS_COMPLETE, tracker)` 注册了一个异步回调：当 Modem 返回发送结果时，`SMSDispatcher` 的 `handleMessage` 方法会收到 `EVENT_SEND_SMS_COMPLETE` 消息，消息对象中携带原始的 `SmsTracker` 引用。

至此，Framework 侧的发送请求已完全移交至 RIL/Modem 层，终端进入等待 Modem 响应的状态。

### 5.3 SMSDispatcher 中的重试机制

`SMSDispatcher` 内置了发送失败自动重试机制。当 `handleSendComplete` 检测到可恢复的错误（如 `RESULT_ERROR_NO_SERVICE`、`RESULT_ERROR_RADIO_OFF`）时，若当前重试次数 `mRetryCount` 未达到最大值（通常为 3 次），则发送 `EVENT_SEND_RETRY` 消息触发重试：

```
handleSendComplete -> 检测到可重试错误
  -> mRetryCount++
  -> sendMessageDelayed(EVENT_SEND_RETRY, tracker, RETRY_INTERVAL)
  -> EVENT_SEND_RETRY 触发 -> sendSms(tracker) 再次尝试
```

重试间隔通常为 2-5 秒，具体取决于运营商配置。若重试次数耗尽仍失败，则调用 `tracker.onFailed()` 将最终结果回调给应用层。

---

## 第 6 章 发送结果处理与 mSentIntent 回调（步骤 7）

### 6.1 步骤 7：EVENT_SEND_SMS_COMPLETE 处理

Modem 完成无线侧发送后，通过 RIL 返回 `RIL_REQUEST_SEND_SMS` 的响应。该响应被封装为 `AsyncResult` 对象，投递到 `SMSDispatcher` 的 Handler 消息队列中，触发 `handleMessage` 对 `EVENT_SEND_SMS_COMPLETE` 的处理：

```java
case EVENT_SEND_SMS_COMPLETE:
    handleSendComplete((AsyncResult) msg.obj);
    break;
```

`AsyncResult` 中携带的关键数据为 `SmsResponse` 对象，包含三个字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `errorCode` | `int` | 发送结果错误码，`0` 表示成功 |
| `messageRef` | `int` | Modem 分配的 TP-MR，与请求时一致 |
| `ackPDU` | `byte[]` | 可选的 ACK PDU，用于需要网络层确认的场景 |

### 6.2 handleSendComplete 分支处理

`handleSendComplete` 是短信发送结果处理的核心方法，其内部逻辑可分为三条分支：

**（1）发送成功**

当 `errorCode == 0` 时：

1. 从 `mSmsTrackerMap` 中根据 `messageRef` 取出对应的 `SmsTracker`
2. 若用户请求了送达报告（`mDeliveryIntent != null`），保留 `SmsTracker` 在 Map 中，等待后续 `RIL_UNSOL_RESPONSE_NEW_SMS_STATUS_REPORT`
3. 调用 `tracker.onSent(mContext)`，内部执行 `mSentIntent.send(Activity.RESULT_OK)`
4. 若未请求送达报告，从 `mSmsTrackerMap` 中移除该 `SmsTracker`，释放资源

**（2）发送失败（可重试）**

当 `errorCode` 为 `RESULT_ERROR_NO_SERVICE`、`RESULT_ERROR_RADIO_OFF` 等临时性错误时：

1. 检查 `mRetryCount` 是否小于最大值
2. 若可重试，递增计数器并发送 `EVENT_SEND_RETRY`
3. 若不可重试，调用 `tracker.onFailed(mContext, resultCode, errorCode)`

**（3）发送失败（不可重试）**

当 `errorCode` 为 `RESULT_ERROR_FDN_CHECK_FAILURE`、`RESULT_ERROR_SHORT_CODE_NOT_ALLOWED` 等永久性错误时，直接调用 `tracker.onFailed()`，将错误码通过 `mSentIntent` 传递给应用层。

### 6.3 mSmsTrackerMap 清理与资源释放

`mSmsTrackerMap` 的生命周期管理遵循以下原则：

- 发送成功且无送达报告请求：立即移除
- 发送成功且有送达报告请求：保留，直到 `triggerDeliveryIntent` 执行后移除
- 发送失败：无论是否可重试，最终都会在回调应用层后移除

若因异常导致 `SmsTracker` 长期滞留，会在 `SMSDispatcher` 销毁或 SIM 卡状态变化时被批量清理。

### 6.4 应用层 PendingIntent 接收结果

应用层通过 `sentIntent` 接收发送结果，结果码定义在 `SmsManager` 中：

| 常量 | 值 | 含义 |
|------|-----|------|
| `RESULT_ERROR_NONE` | 0 | 发送成功 |
| `RESULT_ERROR_GENERIC_FAILURE` | 1 | 通用错误 |
| `RESULT_ERROR_RADIO_OFF` | 2 | 射频关闭 |
| `RESULT_ERROR_NULL_PDU` | 3 | PDU 为空 |
| `RESULT_ERROR_NO_SERVICE` | 4 | 无网络服务 |
| `RESULT_ERROR_LIMIT_EXCEEDED` | 5 | 发送频率超限 |
| `RESULT_ERROR_FDN_CHECK_FAILURE` | 6 | FDN 校验失败 |
| `RESULT_ERROR_SHORT_CODE_NOT_ALLOWED` | 7 | 短码被禁止 |
| `RESULT_ERROR_SHORT_CODE_NEVER_ALLOWED` | 8 | 短码永久被禁止 |

应用层在 `BroadcastReceiver` 中解析 `resultCode`，即可获知短信发送的最终状态。

---

## 第 7 章 送达报告流程（步骤 8）

### 7.1 RIL_UNSOL_RESPONSE_NEW_SMS_STATUS_REPORT 上报

送达报告（Delivery Report）是网络侧在短信成功投递到接收方终端后，向发送方返回的状态通知。与 `RIL_REQUEST_SEND_SMS` 的 solicited response 不同，送达报告属于 unsolicited response，由 Modem 主动上报。

Framework 侧对送达报告的监听在 `GsmSMSDispatcher` 构造函数中完成：

```java
mCi.setOnSmsStatus(this, EVENT_NEW_SMS_STATUS_REPORT, null);
```

该注册使得 Modem 在上报 `RIL_UNSOL_RESPONSE_NEW_SMS_STATUS_REPORT` 时，`SMSDispatcher` 的 `handleMessage` 会收到 `EVENT_NEW_SMS_STATUS_REPORT` 消息。

上报消息的核心数据为状态报告 PDU，其中包含：

- TP-MR（Message Reference）：与原始发送请求中的 TP-MR 一致，用于匹配
- TP-Status：送达状态码，`0x00` 表示成功送达
- TP-RA（Recipient Address）：接收方地址确认
- TP-SCTS（Service Centre Time Stamp）：短信中心时间戳

### 7.2 triggerDeliveryIntent 触发机制

收到 `EVENT_NEW_SMS_STATUS_REPORT` 后，`SMSDispatcher` 触发 `handleSmsStatusReport` 方法，其核心逻辑如下：

1. 解析状态报告 PDU，提取 TP-MR
2. 以 TP-MR 为 Key 在 `mSmsTrackerMap` 中查找对应的 `SmsTracker`
3. 若匹配成功，调用 `triggerDeliveryIntent(tracker)`
4. 在 `triggerDeliveryIntent` 内部执行 `tracker.mDeliveryIntent.send()`
5. 从 `mSmsTrackerMap` 中移除该 `SmsTracker`，完成资源释放

```
Modem 上报 RIL_UNSOL_RESPONSE_NEW_SMS_STATUS_REPORT
  -> handleMessage(EVENT_NEW_SMS_STATUS_REPORT)
    -> handleSmsStatusReport(statusReportPdu)
      -> 提取 messageRef
      -> mSmsTrackerMap.get(messageRef)
      -> triggerDeliveryIntent(tracker)
        -> mDeliveryIntent.send(Activity.RESULT_OK)
```

若 `mSmsTrackerMap` 中未能找到匹配的 `SmsTracker`（例如因超时已被清理），则该送达报告被丢弃并记录警告日志。

### 7.3 送达报告 PendingIntent 的数据封装

`mDeliveryIntent` 的数据封装与 `mSentIntent` 不同：

- `mSentIntent` 携带 `resultCode`（`RESULT_OK` 或错误码）和可选的 `errorCode`
- `mDeliveryIntent` 通常携带 `Activity.RESULT_OK` 以及原始 PDU 数据，应用层可通过 `Intent` 的 extras 获取 `pdu` 字节数组自行解析

应用层区分发送结果与送达报告的依据是注册的 `PendingIntent` 类型：

- `sentIntent`：在调用 `sendTextMessage` / `sendMultipartTextMessage` 时传入的第 4 个参数
- `deliveryIntent`：在调用时传入的第 5 个参数

对于 `sendMultipartTextMessage`，若用户开启了送达报告，每个片段都会独立触发 `mDeliveryIntent`，应用层需自行聚合多部分送达报告。

---

## 第 8 章 多部分短信（Multipart SMS）专项分析

### 8.1 长短信拆分与 divideMessage 原理

`SmsManager.divideMessage` 是长短信拆分的核心方法。其拆分策略基于编码方式的动态检测：

**7-bit GSM 编码**：

- 单条容量：160 字符
- 多部分单段净荷：153 字符（7 字节头部开销：UDH 6 字节 + 填充位 1 字节）
- 适用场景：纯英文、数字及 GSM 基本字符集

**UCS-2 编码**：

- 单条容量：70 字符
- 多部分单段净荷：67 字符（UDH 占用 3 个 UCS-2 编码单元，即 6 字节）
- 适用场景：包含中文、日文、Emoji 等非 GSM 字符集字符

`divideMessage` 的实现会先遍历文本判断是否包含非 7-bit 字符，据此选择编码方式并计算分段边界。

### 8.2 SmsHeader 与 Concat-Ref 的构造

多部分短信的每一段都需要在 PDU 中附加 User Data Header（UDH），其中 Concatenation Information Element 包含：

| 字段 | 长度 | 说明 |
|------|------|------|
| IEI（Information Element Identifier） | 1 byte | 固定为 `0x00`，表示 Concatenated SMS |
| IEDL（Information Element Data Length） | 1 byte | 后续数据长度，固定为 `0x03` |
| Concat-Ref | 1 byte | 重组参考号，同一条长短信的所有片段使用相同值 |
| Seq-Num | 1 byte | 当前片段序号，从 1 开始 |
| Max-Num | 1 byte | 总片段数 |

`Concat-Ref` 由 `SmsDispatcher` 随机生成（范围 0-255），确保同一发送批次中不同长短信的 `Concat-Ref` 不冲突。接收端依据 `Concat-Ref` + `Originating Address` + `SMSC` 三元组识别属于同一长短信的片段，并按 `Seq-Num` 重组。

### 8.3 多部分短信的顺序发送与 mSentIntent 聚合

`sendMultipartTextMessage` 对每个片段独立调用 `sendTextMessageInternal`，这意味着：

- 每个片段都有独立的 `SmsTracker`、`mMessageRef` 和 `mSentIntent`
- 各片段在 RIL 层按调用顺序依次下发，但 Modem 侧的无线发送可能存在乱序
- 应用层收到多个 `sentIntent` 回调，需自行聚合判断整条的最终状态

Android 原生 Messaging 应用通常在所有片段的 `sentIntent` 均返回成功后，才将短信标记为"已发送"。

### 8.4 RIL_REQUEST_SEND_SMS_EXPECT_MORE 的优化作用

在多部分短信场景中，除最后一个片段外，其余片段均通过 `RIL_REQUEST_SEND_SMS_EXPECT_MORE` 发送。该机制向 Modem 传递的语义是"后续还有更多片段"，使得 Modem 可以：

- 保持信令连接（RR/RC 连接），避免每段都重新进行 RACH/信道建立
- 优化无线资源调度，为多段传输预留带宽
- 减少整体发送时延（尤其在网络覆盖边缘场景）

最后一段使用标准的 `RIL_REQUEST_SEND_SMS`，告知 Modem 可以释放相关资源。

---

## 第 9 章 调试与日志

### 9.1 关键 Log TAG

| TAG | 所在类 | 典型日志内容 |
|-----|--------|-------------|
| `SMSDispatcher` | `SMSDispatcher.java` | `sendText`、`sendSms`、`handleSendComplete` 的调用与结果 |
| `GsmSMSDispatcher` | `GsmSMSDispatcher.java` | GSM 专用发送逻辑、送达报告处理 |
| `SmsDispatchersController` | `SmsDispatchersController.java` | IMS/CS 路由决策、Dispatcher 切换 |
| `IccSmsInterfaceManager` | `IccSmsInterfaceManager.java` | SIM 卡接口转发、参数校验失败 |
| `SmsController` | `SmsController.java` | 权限检查、subId 路由 |
| `SmsManager` | `SmsManager.java` | 应用层 API 调用、参数校验 |

### 9.2 常用 adb logcat 过滤命令

```bash
adb logcat -s SMSDispatcher:G GsmSMSDispatcher:G SmsDispatchersController:G IccSmsInterfaceManager:G SmsController:G

adb logcat -s RILJ:D

adb logcat -s SmsDispatchersController:D ImsSmsDispatcher:D

adb logcat -s SMSDispatcher:D | grep -E "(handleSendComplete|onSent|onFailed|errorCode)"
```

### 9.3 dumpsys telephony.registry 与短信相关状态查看

```bash
adb shell dumpsys telephony.registry

adb shell service call isms  # 需要配合具体接口编号
```

### 9.4 常见问题排查思路

**短信发送失败但无回调**

1. 检查 `SmsController` 日志确认权限是否通过
2. 检查 `SmsDispatchersController` 日志确认 IMS/CS 路由是否正常
3. 检查 `SMSDispatcher` 日志确认 `SmsTracker` 是否成功创建
4. 检查 RIL 日志确认请求是否到达 Modem

**mSentIntent 未触发**

1. 确认 `BroadcastReceiver` 已正确注册并可接收隐式广播
2. 检查 `SMSDispatcher` 的 `handleSendComplete` 是否被调用
3. 若 Modem 未返回响应，排查射频/网络注册状态

**送达报告未收到**

1. 确认发送时已传入非空的 `deliveryIntent`
2. 检查 TP-SRR 是否在 PDU 中置位（`SMSDispatcher.sendText` 逻辑）
3. 检查 Modem 是否上报 `RIL_UNSOL_RESPONSE_NEW_SMS_STATUS_REPORT`
4. 确认网络侧是否支持并开启了送达报告功能（部分运营商默认关闭）

**IMS/CS 路由异常**

1. 检查 `dumpsys telephony.registry` 中的 IMS 注册状态
2. 检查 `MmTelFeature` 的 SMS 能力是否上报
3. 在飞行模式切换或网络类型变化时观察路由是否及时更新
4. 确认 `SmsDispatchersController` 是否正确监听了 `EVENT_IMS_STATE_CHANGED`

---

*文档完*