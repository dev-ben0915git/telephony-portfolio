---
title: "Android CS 短信接收全流程分析"
date: "2025-06-27"
summary: "从 Modem 通过 RIL_UNSOL_RESPONSE_NEW_SMS 上报到短信应用收到 SMS_RECEIVED_ACTION 广播的完整 CS 域短信接收链路分析，涵盖 InboundSmsHandler 状态机、GsmInboundSmsHandler 分发、raw 表去重、多部分短信重组与二阶段广播机制。"
category: "sms"
tags: ["InboundSmsHandler", "GsmInboundSmsHandler", "SmsBroadcastReceiver", "InboundSmsTracker", "RadioIndication", "Registrant", "SMS_DELIVER_ACTION", "SMS_RECEIVED_ACTION", "raw表", "MultipartSMS", "WapPushOverSms"]
featured: true
---

---

## 第 1 章 概述

### 1.1 CS 短信接收在 Android Telephony 中的位置

Android 短信接收体系横跨 Modem 固件、RIL（Radio Interface Layer）、Framework 服务层和应用层四个层级。当 SMSC 将短信下发到终端时，Modem 通过 Unsolicited Response 主动上报 Framework，后者经过解析、去重、过滤后，最终通过有序广播将短信投递给目标应用。

Framework 层的短信接收核心代码集中在 `packages/services/Telephony/src/java/com/android/internal/telephony/` 目录下，主要涉及 `InboundSmsHandler` 状态机、`GsmInboundSmsHandler`（GSM 实现）以及 `GsmSMSDispatcher`（接收路径中的辅助角色）。应用层的广播分发则通过 `SmsBroadcastReceiver` 的二阶段机制实现。

### 1.2 整体流程总览

从 Modem 主动上报到短信应用收到广播，完整流程可归纳为 8 个关键步骤：

| 步骤 | 层级 | 关键类/方法 | 职责 |
|------|------|------------|------|
| 1 | RIL / HAL | `RadioIndication.newSms()` | 接收 Modem 上报的 PDU，解析为 SmsMessage |
| 2 | RIL 注册回调 | `mGsmSmsRegistrant.notifyRegistrant()` | 通过 Registrant 机制将 SMS 通知到注册的 Handler |
| 3 | 状态机入口 | `GsmInboundSmsHandler` (EVENT_NEW_SMS) | StateMachine 接收消息，状态从 Idle 转为 Delivering |
| 4 | 短信分发 | `InboundSmsHandler.handleNewSms()` -> `dispatchMessage()` | 解析 SmsMessage，判断消息类型并分流处理 |
| 5 | 存储与去重 | `dispatchNormalMessage()` -> `addTrackerToRawTable()` | 创建 InboundSmsTracker，写入 raw 表，执行重复检测 |
| 6 | 广播分发 | `processMessagePart()` -> `dispatchSmsDeliveryIntent()` | 构造 Intent，执行短信过滤，发送有序广播 |
| 7 | 二阶段广播 | `SmsBroadcastReceiver` -> `SMS_DELIVER_ACTION` | 先投递给默认短信应用，再广播 `SMS_RECEIVED_ACTION` |
| 8 | 清理与恢复 | `deleteFromRawTable()` -> `EVENT_BROADCAST_COMPLETE` | 从 raw 表删除 PDU，状态机返回 Idle |

### 1.3 GSM/CDMA 接收路径对比

Android 为 GSM（3GPP）和 CDMA（3GPP2）分别实现了独立的短信接收状态机：

| 特性 | `GsmInboundSmsHandler` | `CdmaInboundSmsHandler` |
|------|------------------------|-------------------------|
| 继承父类 | `InboundSmsHandler` | `InboundSmsHandler` |
| PDU 格式 | 3GPP（`FORMAT_3GPP`） | 3GPP2（`FORMAT_3GPP2`） |
| RIL 回调 | `mGsmSmsRegistrant`（`setOnNewGsmSms`） | `mCdmaSmsRegistrant`（`setOnNewCdmaSms`） |
| ACK 方法 | `acknowledgeLastIncomingGsmSms()` | `acknowledgeLastIncomingCdmaSms()` |
| 状态报告 | 不处理（由发送路径处理） | 处理部分 CDMA 专用状态报告 |

IMS 短信接收走 `ImsSmsDispatcher` 的注入路径（`EVENT_INJECT_SMS`），最终也进入 `InboundSmsHandler` 状态机处理，但 `InboundSmsTracker` 中的 `smsSource` 标记为 `SOURCE_INJECTED_FROM_IMS`。

**本文以 GSM 3GPP 路径为主线**进行说明。

### 1.4 关键术语解释

| 术语 | 说明 |
|------|------|
| Registrant | RIL 中的回调注册机制，封装 Handler + what + obj 三元组，用于将 Unsolicited Response 路由到上层 Handler |
| InboundSmsTracker | 追踪入站短信生命周期的数据结构，封装 PDU、参考号、序列号、目标端口等 |
| Raw Table | `SmsProvider` 中的原始 PDU 存储表（`raw` 表），用于防止设备崩溃导致短信丢失 |
| SmsBroadcastReceiver | 有序广播的结果接收器，处理二阶段广播与 raw 表清理 |
| WakeLock | 短信处理期间持有的 Partial WakeLock，防止设备休眠导致广播未完成 |
| Type Zero SMS | 3GPP 规范定义的特殊短信（TP-MTI = 0x00），不显示、不存储，仅 ACK |
| MWI | Message Waiting Indicator，语音信箱等待指示器更新短信 |

---

## 第 2 章 关键类与数据结构

### 2.1 RadioIndication：RIL Indication 回调入口

`RadioIndication` 实现 `IRadioIndication` 接口（HIDL/AIDL），负责接收所有来自 Modem 的 Unsolicited Response。其 `newSms()` 方法是短信接收链路的起点：

```
RadioIndication.newSms(indicationType, pdu)
  -> pduArray: ArrayList<Byte> 转换为 byte[]
  -> SmsMessage.createFromPdu(pduArray)  // 3GPP PDU 解析为 SmsMessageBase
  -> new SmsMessage(smsb)                  // 包装为 android.telephony.SmsMessage
  -> mGsmSmsRegistrant.notifyRegistrant(new AsyncResult(null, sms, null))
```

`mGsmSmsRegistrant` 是 `Registrant` 对象，内部持有 `GsmInboundSmsHandler` 的 Handler 引用和消息类型 `EVENT_NEW_SMS`。

### 2.2 BaseCommands / RIL：Registrant 注册与 ACK 机制

`BaseCommands`（被 `RIL` 继承）定义了短信接收的回调注册字段和方法：

| 字段/方法 | 说明 |
|---------|------|
| `mGsmSmsRegistrant` | GSM 新短信回调的 Registrant |
| `mCdmaSmsRegistrant` | CDMA 新短信回调的 Registrant |
| `mSmsStatusRegistrant` | 短信状态报告回调的 Registrant |
| `setOnNewGsmSms(Handler h, int what, Object obj)` | 注册 GSM 短信回调 |
| `acknowledgeLastIncomingGsmSms(boolean success, int cause)` | GSM 短信 ACK |

ACK 机制的作用：Framework 收到短信并完成解析后，通过此方法通知 Modem，Modem 据此向 SMSC 发送 RP-ACK（或者 RP-ERROR），告知网络侧短信已被终端成功接收。若 Framework 未及时 ACK，Modem 可能会重发短信。

### 2.3 InboundSmsHandler：短信接收状态机基类

`InboundSmsHandler` 继承自 Android 的 `StateMachine`，是整个短信接收流程的骨架。它定义了 5 个状态，通过状态转换协调串行处理、WakeLock 管理和多消息排队：

| 状态 | 父状态 | 职责 |
|------|--------|------|
| `DefaultState` | 无 | 处理未匹配消息的兜底逻辑 |
| `StartupState` | `DefaultState` | 启动等待，等待 `SmsBroadcastUndelivered` 完成 |
| `IdleState` | `DefaultState` | 空闲等待，延迟释放 WakeLock |
| `DeliveringState` | `DefaultState` | 投递处理，执行 `handleNewSms` 和 `processMessagePart` |
| `WaitingState` | `DeliveringState` | 广播等待，等待有序广播完成后再处理下一条 |

状态层级关系：

```
DefaultState
  +-- StartupState
  +-- IdleState
  +-- DeliveringState
        +-- WaitingState
```

核心成员变量：

| 字段 | 类型 | 说明 |
|------|------|------|
| `mWapPush` | `WapPushOverSms` | WAP Push 消息处理器 |
| `mWakeLock` | `PowerManager.WakeLock` | 短信处理期间持有的 WakeLock |
| `mStorageMonitor` | `SmsStorageMonitor` | 短信存储空间监控 |
| `mSmsFilters` | `List<SmsFilter>` | 短信过滤链（CarrierServices、VisualVoicemail、MissedIncomingCall） |
| `mPhone` | `Phone` | Phone 实例引用 |
| `mLastDeliveredSmsTracker` | `InboundSmsTracker` | 最近一次投递的 Tracker 引用 |

### 2.4 GsmInboundSmsHandler：GSM 短信接收实现

`GsmInboundSmsHandler` 继承 `InboundSmsHandler`，是 GSM 3GPP 短信接收的具体实现。构造函数中完成 RIL 回调注册：

```java
phone.mCi.setOnNewGsmSms(getHandler(), EVENT_NEW_SMS, null);
```

其核心重写方法 `dispatchMessageRadioSpecific()` 按优先级依次处理以下消息类型：

1. **Type Zero 短信**：不显示、不存储，仅通过 `VisualVoicemailSmsFilter` 过滤后返回 `RESULT_SMS_HANDLED`
2. **USIM Data Download（SMS-PP）**：委托 `UsimDataDownloadHandler.handleUsimDataDownload()` 处理
3. **MWI（Message Waiting Indicator）短信**：更新语音信箱等待指示器，若 `isMwiDontStore()` 为 true 则不继续存储
4. **存储空间检查**：调用 `mStorageMonitor.isStorageAvailable()`，空间不足则丢弃并通知用户
5. **普通文本/数据短信**：调用 `dispatchNormalMessage()` 进入标准处理流程

`acknowledgeLastIncomingSms()` 方法负责将处理结果映射为 3GPP TP-ACK Cause 码后调用 RIL ACK。

### 2.5 InboundSmsTracker：入站短信追踪器

`InboundSmsTracker` 是 `InboundSmsHandler` 的内部类，封装单条入站短信（或单段多部分短信）的完整信息：

| 字段 | 类型 | 说明 |
|------|------|------|
| `mPdu` | `byte[]` | 短信 PDU 原始数据 |
| `mTimestamp` | `long` | 接收时间戳 |
| `mDestPort` | `int` | 目标端口（-1 表示文本短信） |
| `mIs3gpp2` | `boolean` | 是否为 3GPP2 格式 |
| `mAddress` | `String` | 发送方地址（多部分短信用于去重） |
| `mReferenceNumber` | `int` | 多部分短信的 Concat-Ref 参考号 |
| `mSequenceNumber` | `int` | 当前片段序号 |
| `mMessageCount` | `int` | 总片段数 |
| `mMessageId` | `long` | 消息唯一标识（基于 PDU Hash 生成） |
| `mSubId` | `int` | 订阅 ID |

目标端口标志位：

| 标志 | 值 | 含义 |
|------|-----|------|
| `DEST_PORT_FLAG_NO_PORT` | -1 | 文本短信，无特定端口 |
| `DEST_PORT_FLAG_3GPP` | 0-65535 | 3GPP 数据短信端口 |
| `DEST_PORT_FLAG_3GPP2` | 0-65535 | 3GPP2 数据短信端口 |
| `DEST_PORT_FLAG_3GPP2_WAP_PDU` | 特殊值 | 3GPP2 WAP Push |

`InboundSmsTracker` 与 raw 表的交互通过 `getContentValues()`（写入）、`getDeleteWhere()`（删除）、`getQueryForSegments()`（查询多部分片段）实现。

### 2.6 GsmSMSDispatcher：接收路径中的角色

`GsmSMSDispatcher` 在**发送路径**中是核心角色，但在**接收路径**中职责有限：

- 持有 `mGsmInboundSmsHandler` 引用，用于创建和管理接收状态机
- 处理 `EVENT_NEW_ICC_SMS`：SIM 卡短信（EF_SMS）转发到 `GsmInboundSmsHandler`
- 处理 `EVENT_NEW_SMS_STATUS_REPORT`：短信送达状态报告，通过 `SmsDispatchersController.handleSmsStatusReport()` 处理
- 注册 `mCi.setOnSmsStatus(this, EVENT_NEW_SMS_STATUS_REPORT, null)` 监听状态报告

普通短信接收的完整逻辑在 `GsmInboundSmsHandler` 中，不经过 `GsmSMSDispatcher`。

### 2.7 WapPushOverSms：WAP Push 处理（简要提及）

`WapPushOverSms` 处理端口为 `PORT_WAP_PUSH`（2948）的消息，主要包括 MMS 通知。其 `dispatchWapPdu()` 方法将 WAP Push PDU 解析后分发到对应的应用处理器（如 MMS 服务）。

### 2.8 SmsBroadcastReceiver：二阶段广播结果接收器

`SmsBroadcastReceiver` 是 `InboundSmsHandler` 的内部类，继承 `BroadcastReceiver`，负责处理有序广播的结果。其核心设计为**二阶段广播**：

1. 第一阶段：`SMS_DELIVER_ACTION` -> 仅投递给默认短信应用（通过 ComponentName 精确匹配）
2. 第一阶段完成后，将 Action 改为 `SMS_RECEIVED_ACTION`，清除 ComponentName
3. 第二阶段：`SMS_RECEIVED_ACTION` -> 广播给所有拥有 `RECEIVE_SMS` 权限的接收者
4. 第二阶段完成后，从 raw 表删除 PDU，发送 `EVENT_BROADCAST_COMPLETE`

超时保护：`EVENT_RECEIVER_TIMEOUT`（默认 10 分钟）触发 `fakeNextAction()` 降级处理。

---

## 第 3 章 RIL 消息交互

### 3.1 RIL_UNSOL_RESPONSE_NEW_SMS：新短信上报

当 Modem 收到 SMSC 转发的 SMS 点对点消息时，通过 HIDL/AIDL `IRadioIndication` 接口上报 `RIL_UNSOL_RESPONSE_NEW_SMS`。上报参数为 `ArrayList<Byte> pdu`，包含 3GPP 格式的完整 PDU 字节数组。

Framework 侧在 `RadioIndication.newSms()` 中完成以下处理：

1. 将 `ArrayList<Byte>` 转换为 `byte[]`
2. 调用 `SmsMessage.createFromPdu(pduArray)` 将 PDU 解析为 `SmsMessageBase`（具体为 `GsmSmsMessage`）
3. 封装为 `android.telephony.SmsMessage`（持有 `mWrappedSmsMessage` 引用）
4. 通过 `mGsmSmsRegistrant.notifyRegistrant(new AsyncResult(null, sms, null))` 通知注册的 Handler

### 3.2 RIL_UNSOL_RESPONSE_NEW_SMS_STATUS_REPORT：状态报告上报

当网络侧返回短信送达状态报告时，Modem 上报此消息。Framework 侧在 `RadioIndication.newSmsStatusReport()` 中处理，通过 `mSmsStatusRegistrant` 通知到 `GsmSMSDispatcher`（`EVENT_NEW_SMS_STATUS_REPORT`）。状态报告的处理在短信**发送流程**中已完成（匹配 `mSmsTrackerMap` 后触发 `triggerDeliveryIntent`），与接收流程相对独立。

### 3.3 GSM ACK 机制：acknowledgeLastIncomingGsmSms

ACK 是 Framework 向 Modem 确认短信已成功接收的机制。Modem 收到 ACK 后向 SMSC 发送 RP-ACK，避免 SMSC 重发短信。

ACK 调用时机取决于消息处理结果：

- `dispatchMessageRadioSpecific()` 返回非 `RESULT_OK`（如 Type Zero 短信返回 `RESULT_SMS_HANDLED`）：在 `handleNewSms()` 中立即 ACK
- 返回 `RESULT_OK`（如 SMS-PP Data Download）：由特殊处理逻辑自行延迟 ACK
- 普通文本短信：在 raw 表写入成功后 ACK

ACK 参数包含 `success`（布尔值）和 `cause`（3GPP TP-FCS Cause 码）。失败时 Cause 值由 `resultToCause()` 方法映射。

### 3.4 RIL_UNSOL_RESPONSE_NEW_SMS_ON_SIM：SIM 卡短信通知

当网络侧将短信直接存储到 SIM 卡的 EF_SMS 文件时，Modem 上报此消息。`RadioIndication.newSmsOnSim()` 通过 `mSmsOnSimRegistrant` 通知上层，最终由 `GsmSMSDispatcher` 的 `EVENT_NEW_ICC_SMS` 处理并转发给 `GsmInboundSmsHandler`。

---

## 第 4 章 InboundSmsHandler 状态机详解

### 4.1 状态机架构总览

`InboundSmsHandler` 继承 Android 的 `StateMachine` 框架，通过 5 个状态的有序转换实现短信接收的串行化处理。这种设计确保同一时刻只有一条短信在执行广播分发，避免并发广播导致的顺序混乱。

状态层级与转换关系：

```
DefaultState（根状态）
  |
  +-- StartupState（初始状态）
  |     |
  |     +-- [EVENT_START_ACCEPTING_SMS] --> IdleState
  |
  +-- IdleState
  |     |
  |     +-- [EVENT_NEW_SMS / EVENT_BROADCAST_SMS] --> defer + DeliveringState
  |     +-- [EVENT_RELEASE_WAKELOCK] --> 释放 WakeLock
  |
  +-- DeliveringState
        |
        +-- [EVENT_NEW_SMS] --> handleNewSms() + EVENT_RETURN_TO_IDLE
        +-- [EVENT_BROADCAST_SMS] --> processMessagePart()
        |     |
        |     +-- 广播已发送 --> WaitingState
        |     +-- 无需广播 --> EVENT_RETURN_TO_IDLE
        |
        +-- [EVENT_RETURN_TO_IDLE] --> IdleState
        |
        +-- WaitingState（DeliveringState 的子状态）
              |
              +-- [EVENT_BROADCAST_SMS] --> defer
              +-- [EVENT_BROADCAST_COMPLETE] --> EVENT_RETURN_TO_IDLE + DeliveringState
              +-- [EVENT_RECEIVER_TIMEOUT] --> fakeNextAction()
```

### 4.2 StartupState：启动等待状态

`StartupState` 是状态机的初始状态。开机或 SIM 卡热插后，`GsmInboundSmsHandler` 从此状态启动，等待 `SmsBroadcastUndelivered` 完成对 raw 表的扫描。

- **进入行为**：设置 WakeLock 超时为 0（无待处理消息时立即释放）
- **EVENT_NEW_SMS / EVENT_INJECT_SMS / EVENT_BROADCAST_SMS**：全部 defer，暂不处理，等待状态就绪
- **EVENT_START_ACCEPTING_SMS**：触发 `transitionTo(mIdleState)`，进入空闲状态

`SmsBroadcastUndelivered` 在开机时扫描 raw 表中上次未完成广播的短信（设备可能在广播过程中崩溃），逐条重新投递，全部完成后发送 `EVENT_START_ACCEPTING_SMS`。

### 4.3 IdleState：空闲等待状态

`IdleState` 是状态机的核心稳态，表示当前无短信正在处理。

- **进入行为（enter）**：发送延迟的 `EVENT_RELEASE_WAKELOCK` 消息（默认 3 秒），若 3 秒内无新短信则释放 WakeLock，降低功耗
- **退出行为（exit）**：立即获取 WakeLock，确保后续短信处理期间设备不休眠
- **EVENT_NEW_SMS / EVENT_INJECT_SMS / EVENT_BROADCAST_SMS**：先将消息 defer（延迟到下一个状态处理），然后 `transitionTo(mDeliveringState)`
- **EVENT_RELEASE_WAKELOCK**：调用 `mWakeLock.release()` 释放 WakeLock

defer + transition 的组合是 StateMachine 的惯用模式：消息先被推迟处理，状态切换到 `DeliveringState` 后，被推迟的消息在 `DeliveringState.processMessage()` 中被重新分发。

### 4.4 DeliveringState：投递处理状态

`DeliveringState` 是执行短信处理的核心状态，承载 `handleNewSms()` 和 `processMessagePart()` 两个核心方法的调用。

**处理 EVENT_NEW_SMS**：

```
case EVENT_NEW_SMS:
    handleNewSms((AsyncResult) msg.obj);
    sendMessage(EVENT_RETURN_TO_IDLE);
    return HANDLED;
```

`handleNewSms()` 完成短信解析、类型判断、raw 表写入后返回。若成功进入广播流程，后续会收到 `EVENT_BROADCAST_SMS` 消息（由 `addTrackerToRawTableAndSendMessage` 发送）。`handleNewSms()` 本身不阻塞等待广播完成，而是立即发送 `EVENT_RETURN_TO_IDLE`，由 `DeliveringState` 自行处理。

**处理 EVENT_BROADCAST_SMS**：

```
case EVENT_BROADCAST_SMS:
    int result = processMessagePart(tracker);
    if (result == Intents.RESULT_SMS_HANDLED) {
        // 广播已发送，等待完成
        transitionTo(mWaitingState);
    } else {
        // 无需广播（如过滤拦截），避免 StateMachine 卡住
        sendMessage(EVENT_RETURN_TO_IDLE);
    }
    return HANDLED;
```

**处理 EVENT_RETURN_TO_IDLE**：

直接 `transitionTo(mIdleState)`，回到空闲状态等待下一条短信。

### 4.5 WaitingState：广播等待状态

`WaitingState` 是 `DeliveringState` 的子状态，等待当前有序广播的接收者全部处理完毕。在此期间，新的 `EVENT_NEW_SMS` 消息会被 defer，确保串行化处理。

- **EVENT_BROADCAST_SMS**：defer，排队等待当前广播完成
- **EVENT_BROADCAST_COMPLETE**：清除 `mLastDeliveredSmsTracker` 引用，发送 `EVENT_RETURN_TO_IDLE`，`transitionTo(mDeliveringState)`（先回到 Delivering 再转 Idle）
- **EVENT_RECEIVER_TIMEOUT**：广播超时（默认 10 分钟），调用 `fakeNextAction()` 降级处理（模拟广播完成，继续后续流程）
- **退出行为（exit）**：设置 WakeLock 超时为 `WAKELOCK_TIMEOUT`（3000ms），通知 `SmsDispatchersController` 当前投递结束

`WaitingState` 确保了有序广播的完整性：只有当前广播的所有接收者处理完毕（或超时降级）后，才会开始处理下一条短信的广播。

---

## 第 5 章 短信接收核心处理流程（步骤 1-5）

### 5.1 步骤 1：Modem 上报 -> RadioIndication.newSms()

Modem 通过无线网络收到 SMSC 转发的 SMS 点对点消息后，将 PDU 封装为 RIL Indication 上报给 Framework。具体调用链如下：

```
Modem
  -> IRadioIndication.newSms(pdu)  // HIDL/AIDL 接口调用
    -> RadioIndication.newSms(indicationType, pdu)
      -> pduArray = new byte[pdu.size()]
      -> 将 ArrayList<Byte> 逐字节拷贝到 pduArray
      -> SmsMessage sms = SmsMessage.createFromPdu(pduArray, SmsConstants.FORMAT_3GPP)
      -> mGsmSmsRegistrant.notifyRegistrant(new AsyncResult(null, sms, null))
```

`SmsMessage.createFromPdu()` 内部调用 `GsmSmsMessage.createPdu()` 完成底层 PDU 解析，提取发送方地址、时间戳、用户数据等字段，最终返回 `android.telephony.SmsMessage` 包装对象。

### 5.2 步骤 2：Registrant 通知 -> Handler 回调

`Registrant.notifyRegistrant()` 的内部实现极为简单：

```java
public void notifyRegistrant(AsyncResult ar) {
    Handler h = getHandler();   // GsmInboundSmsHandler 的 Handler
    int what = mWhat;           // EVENT_NEW_SMS
    Object obj = mUserObj;      // null
    Message msg = Message.obtain(h, what, ar);
    h.sendMessage(msg);
}
```

此消息被投递到 `GsmInboundSmsHandler` 内部 StateMachine 的 `Handler` 队列中。StateMachine 的 `handleMessage()` 会根据当前活跃状态调用对应 `State.processMessage()`。

### 5.3 步骤 3：StateMachine 接收 -> 状态转换

当状态机处于 `IdleState` 时，收到 `EVENT_NEW_SMS` 消息的处理流程：

```
IdleState.processMessage(EVENT_NEW_SMS)
  -> deferMessage(msg)           // 将消息推迟到下一状态处理
  -> transitionTo(DeliveringState)  // 切换到 DeliveringState

DeliveringState.enter()
  -> 被推迟的 EVENT_NEW_SMS 在此处重新分发

DeliveringState.processMessage(EVENT_NEW_SMS)
  -> handleNewSms((AsyncResult) msg.obj)
  -> sendMessage(EVENT_RETURN_TO_IDLE)
```

### 5.4 步骤 4：handleNewSms() -> dispatchMessage() -> dispatchMessageRadioSpecific()

`handleNewSms()` 是短信接收处理的核心入口方法，完成从 `SmsMessage` 对象到具体处理分支的路由：

```java
protected void handleNewSms(AsyncResult ar) {
    SmsMessage sms = (SmsMessage) ar.result;
    int result = dispatchMessage(sms.mWrappedSmsMessage, SOURCE_NOT_INJECTED, 0);
    // 根据 result 调用 acknowledgeLastIncomingSms() ACK
    notifyAndAcknowledgeLastIncomingSms(result, 0, null);
}
```

`dispatchMessage()` 内部执行多层前置检查和分流：

1. **空值检查**：`smsb == null` 则返回 `RESULT_ERROR_GENERIC_FAILURE`
2. **接收禁用检查**：`mSmsReceiveDisabled` 为 true 则丢弃
3. **MT SMS Polling 过滤**：MT SMS Polling 机制产生的消息直接返回 `RESULT_SMS_HANDLED`
4. **Satellite 模式丢弃**：卫星模式下不处理 CS 短信
5. **调用 `dispatchMessageRadioSpecific()`**：进入 GSM 专用处理路径

`dispatchMessageRadioSpecific()` 在 `GsmInboundSmsHandler` 中按以下优先级处理：

| 优先级 | 消息类型 | 处理方式 | 返回值 |
|--------|---------|---------|--------|
| 1 | Type Zero 短信 | VisualVoicemailSmsFilter 过滤，ACK | `RESULT_SMS_HANDLED` |
| 2 | USIM Data Download | `UsimDataDownloadHandler` 处理 | `RESULT_SMS_HANDLED` 或延迟 ACK |
| 3 | MWI Set/Clear | 更新语音信箱指示器 | 取决于 `isMwiDontStore()` |
| 4 | 存储空间不足 | 丢弃并通知用户 | `RESULT_ERROR_GENERIC_FAILURE` |
| 5 | 普通短信 | 调用 `dispatchNormalMessage()` | `RESULT_OK` 或错误 |

### 5.5 步骤 5：dispatchNormalMessage() -> InboundSmsTracker -> raw 表

`dispatchNormalMessage()` 负责将普通文本/数据短信封装为 `InboundSmsTracker` 并持久化到 raw 表。

**（1）PDU 解析与 Tracker 创建**

首先解析 `SmsHeader` 判断是否为多部分短信，然后创建 `InboundSmsTracker`：

```
dispatchNormalMessage(smsb)
  -> 解析 SmsHeader（UserData Header）
    -> 有 ConcatRef：多部分短信
      -> 提取 refNumber / seqNumber / msgCount
      -> 解析 portAddrs 获取 destPort
    -> 无 ConcatRef：单部分短信
      -> destPort = -1（文本短信）或从 portAddrs 获取
  -> 创建 InboundSmsTracker(pdu, timestamp, destPort, is3gpp2, address, 
      refNumber, seqNumber, msgCount, messageId, subId)
```

**（2）写入 raw 表与去重检测**

`addTrackerToRawTableAndSendMessage(tracker, deDup)` 完成两件事：

1. 调用 `addTrackerToRawTable(tracker)` 将 PDU 写入 raw 表
2. 执行去重检测 `checkAndHandleDuplicate()`

去重检测采用两轮匹配：

- **精确匹配**：PDU Hash + 地址 + 参考号 + 序号完全相同，返回 `RESULT_SMS_DUPLICATED`，直接丢弃
- **非精确匹配**：相同参考号但不同序号（可能是重发的多部分片段），用新 PDU 覆盖 raw 表中的旧记录

raw 表写入通过 ContentProvider 完成：

```java
ContentValues values = tracker.getContentValues();
Uri uri = mResolver.insert(sRawUri, values);  // sRawUri = "content://sms/raw"
```

写入成功后，发送 `EVENT_BROADCAST_SMS` 消息，触发 `DeliveringState` 中的 `processMessagePart()` 处理。

---

## 第 6 章 广播分发与应用通知（步骤 6-8）

### 6.1 步骤 6：processMessagePart() 核心处理

`processMessagePart()` 是 raw 表写入后、广播发送前的最后一个核心处理节点，负责完成多部分短信的等齐检查、拦截检测、过滤和最终分发。

**单部分短信处理**：

```
processMessagePart(tracker)
  -> destPort == -1（文本短信）
  -> BlockChecker.isBlocked(mContext, tracker.mDisplayAddress, tracker.mSubId)
    -> 被拦截：返回 RESULT_SMS_HANDLED，不发送广播
    -> 未被拦截：继续
  -> filterSms(tracker)  // 三级过滤链
    -> 被过滤：dropFilteredSms(tracker)，返回 RESULT_SMS_HANDLED
    -> 未被过滤：继续
  -> dispatchSmsDeliveryIntent(tracker)  // 发送广播
```

**多部分短信处理**：

```
processMessagePart(tracker)
  -> tracker.mMessageCount > 1（多部分短信）
  -> 查询 raw 表：tracker.getQueryForSegments() 获取所有已到达片段
  -> 检查是否所有片段已到齐
    -> 未到齐：返回 RESULT_SMS_HANDLED，等待后续片段触发新的 EVENT_BROADCAST_SMS
    -> 已到齐：将所有片段按 seqNumber 排序后合并
      -> BlockChecker.isBlocked() 拦截检查
      -> filterSms() 过滤链
      -> dispatchSmsDeliveryIntent() 发送广播
```

对于未到齐的多部分短信，后续片段到达时会再次触发 `addTrackerToRawTableAndSendMessage()` -> `EVENT_BROADCAST_SMS` -> `processMessagePart()`，直到所有片段到齐。

### 6.2 短信过滤机制详解

`InboundSmsHandler` 维护一个 `List<SmsFilter>` 过滤链，包含三级过滤器，依次执行：

| 过滤器 | 执行方式 | 职责 |
|--------|---------|------|
| `CarrierServicesSmsFilter` | 异步回调 | 运营商短信服务过滤，拦截运营商特定的管理类短信 |
| `VisualVoicemailSmsFilter` | 同步检查 | 可视化语音信件短信识别，拦截并转交给语音信箱应用 |
| `MissedIncomingCallSmsFilter` | 同步检查 | 未接来电通知短信识别，拦截并更新通话记录 |

过滤链调用流程：

```
filterSms(tracker)
  -> mSmsFilters.get(0).filter(tracker, callback)  // CarrierServicesSmsFilter
    -> 返回 true：拦截，dropFilteredSms(tracker)
    -> 返回 false：继续
  -> mSmsFilters.get(1).filter(tracker, callback)  // VisualVoicemailSmsFilter
    -> 返回 true：拦截
    -> 返回 false：继续
  -> mSmsFilters.get(2).filter(tracker, callback)  // MissedIncomingCallSmsFilter
    -> 返回 true：拦截
    -> 返回 false：继续到 dispatchSmsDeliveryIntent()
```

`CarrierServicesSmsFilter` 支持异步回调，需要运营商配置 `carrier_app_whitelist` 才会激活。其余两个过滤器为同步检查。

### 6.3 步骤 7：dispatchSmsDeliveryIntent() 构造与发送 Intent

`dispatchSmsDeliveryIntent()` 负责将短信封装为 Intent 并通过 `dispatchIntent()` 发送有序广播。其核心逻辑根据目标端口区分：

**文本短信（destPort == -1）**：

```
dispatchSmsDeliveryIntent(tracker)
  -> action = Intents.SMS_DELIVER_ACTION
  -> 获取默认短信应用 ComponentName
  -> intent.setComponent(defaultSmsApp)
  -> intent.putExtra("pdus", pduArray)
  -> intent.putExtra("format", SmsConstants.FORMAT_3GPP)
  -> intent.putExtra("subId", tracker.mSubId)
  -> intent.putExtra("messageId", tracker.mMessageId)
  -> dispatchIntent(intent, SMS_DELIVER_PERMISSION)
```

**数据短信（destPort != -1）**：

```
dispatchSmsDeliveryIntent(tracker)
  -> action = Intents.DATA_SMS_RECEIVED_ACTION
  -> uri = Uri.parse("sms://localhost:" + destPort)
  -> intent.setData(uri)
  -> dispatchIntent(intent, SMS_DELIVER_PERMISSION)
```

`dispatchIntent()` 内部还会执行：

1. **`AppSmsManager.handleSmsReceivedIntent()`**：拦截检查（如 VoLTE 短信）
2. **`handleSmsWhitelisting()`**：权限白名单处理
3. **OTP 检测**：通过 `TextClassifier` 识别一次性密码短信，额外发送给可信包
4. **`sendOrderedBroadcast()`**：发送有序广播，权限要求 `RECEIVE_SMS` + AppOp `OPSTR_RECEIVE_SMS`

### 6.4 步骤 8：SmsBroadcastReceiver 二阶段广播与 raw 表清理

`SmsBroadcastReceiver` 在 `dispatchIntent()` 中被注册为有序广播的 `BroadcastReceiver`，其 `onReceive()` 实现了二阶段广播的核心逻辑。

**第一阶段完成（SMS_DELIVER_ACTION）**：

```
SmsBroadcastReceiver.onReceive(context, intent)
  -> action == SMS_DELIVER_ACTION
  -> 第二阶段广播：
    -> intent.setAction(SMS_RECEIVED_ACTION)  // 更换 Action
    -> intent.setComponent(null)               // 清除 ComponentName，广播给所有接收者
    -> sendOrderedBroadcast(intent, ...)
  -> 将 mLastDeliveredSmsTracker 引用传递到第二阶段
```

**第二阶段完成（SMS_RECEIVED_ACTION）**：

```
SmsBroadcastReceiver.onReceive(context, intent)
  -> action == SMS_RECEIVED_ACTION
  -> deleteFromRawTable(mLastDeliveredSmsTracker)  // 从 raw 表删除 PDU
  -> sendMessage(EVENT_BROADCAST_COMPLETE)            // 通知状态机广播完成
```

**超时保护**：

若有序广播在 10 分钟内未完成（某个接收者阻塞），`WaitingState` 收到 `EVENT_RECEIVER_TIMEOUT`，调用 `fakeNextAction()` 模拟广播完成，从 raw 表删除 PDU 后继续处理下一条短信。

### 6.5 应用层接收广播

短信应用通过注册 `BroadcastReceiver` 接收以下 Action 的广播：

| Action | 接收者范围 | 用途 |
|--------|----------|------|
| `SMS_DELIVER_ACTION` | 仅默认短信应用 | 第一阶段投递，优先处理 |
| `SMS_RECEIVED_ACTION` | 所有拥有 `RECEIVE_SMS` 权限的应用 | 第二阶段广播，全量通知 |
| `DATA_SMS_RECEIVED_ACTION` | 拥有对应端口权限的应用 | 数据短信通知 |
| `WAP_PUSH_DELIVER_ACTION` / `WAP_PUSH_RECEIVED_ACTION` | MMS 应用等 | WAP Push 通知 |

Intent 携带的 Extra 数据：

| Extra | 类型 | 说明 |
|-------|------|------|
| `pdus` | `Object[]`（`byte[]`） | PDU 字节数组 |
| `format` | `String` | PDU 格式（`3gpp` / `3gpp2`） |
| `subId` | `int` | 订阅 ID |
| `messageId` | `long` | 消息唯一标识 |

应用层通过 `Telephony.Sms.Intents.getMessagesFromIntent(intent)` 从 `pdus` Extra 中解析出 `SmsMessage` 对象列表。

---

## 第 7 章 多部分短信接收专项分析

### 7.1 多部分短信的重组原理

长短信在发送端被拆分为多个片段，每个片段的 PDU 中包含 User Data Header（UDH），其中 Concatenation Information Element 记录重组信息：

| 字段 | 长度 | 说明 |
|------|------|------|
| IEI | 1 byte | 固定为 `0x00`（Concatenated SMS）或 `0x08`（16-bit 参考号） |
| IEDL | 1 byte | 数据长度（3 或 4） |
| Concat-Ref | 1 or 2 bytes | 重组参考号（8-bit 范围 0-255，16-bit 范围 0-65535） |
| Seq-Num | 1 byte | 当前片段序号，从 1 开始 |
| Max-Num | 1 byte | 总片段数 |

接收端依据 `Concat-Ref` + `Originating Address` + `SMSC` 三元组识别属于同一长短信的片段，并按 `Seq-Num` 排序后重组为完整文本。

### 7.2 raw 表中的多部分短信存储与等齐逻辑

每个多部分短信片段独立存储在 raw 表中，共享相同的 `referenceNumber` 和 `address`，但 `sequenceNumber` 不同。

`processMessagePart()` 中的等齐逻辑：

```
1. tracker.getMessageCount() > 1  // 多部分短信
2. cursor = mResolver.query(sRawUri, tracker.getQueryForSegments(), ...)
   -> 查询条件：referenceNumber + address 匹配
   -> 返回所有已到达片段的 cursor
3. 检查 cursor.count == tracker.mMessageCount
   -> 不等齐：返回 RESULT_SMS_HANDLED，等待后续片段
   -> 等齐：将所有片段的 PDU 按 sequenceNumber 排序后合并
4. 合并后的完整 PDU 交给后续的过滤和广播流程
```

当 `WaitingState` 处于广播等待期间，新到达的多部分片段的 `EVENT_BROADCAST_SMS` 被 defer。广播完成后回到 `DeliveringState`，被 defer 的消息重新处理，检查是否等齐。

### 7.3 多部分短信的去重策略

`checkAndHandleDuplicate()` 对多部分短信执行两轮检测：

- **精确匹配**：PDU Hash + `address` + `referenceNumber` + `sequenceNumber` 完全相同，判定为重复短信，返回 `RESULT_SMS_DUPLICATED`，新 PDU 不写入 raw 表
- **非精确匹配**：相同 `referenceNumber` + `address` 但不同 `sequenceNumber`（可能是重发的某个片段），用新 PDU 覆盖 raw 表中的旧记录，确保旧片段不会阻碍等齐判断

这一策略防止了 SMSC 重发导致的重复投递，同时保证了多部分短信的完整重组。

---

## 第 8 章 特殊短信类型处理

### 8.1 Type Zero 短信

Type Zero 短信在 3GPP TS 23.040 9.2.3.9 中定义，其 TP-MTI 为 `0x00`（SMS-DELIVER），且 TP-PID 设置为 `0x41`（Return Call Message）或其他非交互值。这类短信不显示、不存储，仅要求接收端 ACK。

在 `GsmInboundSmsHandler.dispatchMessageRadioSpecific()` 中，Type Zero 短信被最先识别并处理。通过 `VisualVoicemailSmsFilter` 过滤后返回 `RESULT_SMS_HANDLED`，`handleNewSms()` 随即调用 `acknowledgeLastIncomingSms()` 完成 ACK，不进入 raw 表写入和广播流程。

### 8.2 MWI 短信

MWI（Message Waiting Indicator）短信用于更新语音信箱等待指示器。`GsmSmsMessage` 提供 `isMWISetMessage()` 和 `isMWIClearMessage()` 方法判断指示器状态。

处理流程：

1. 识别 MWI 短信后，调用 `mPhone.setVoiceMessageCount(count)` 更新状态栏语音信箱图标
2. 若 `sms.isMwiDontStore()` 返回 true，不继续存储和广播
3. 若需要存储，调用 `dispatchNormalMessage()` 进入标准流程

MWI 短信通常由运营商网络主动下发，用于通知用户有新的语音留言。

### 8.3 SMS-PP Data Download

SMS-PP（SMS Protocol Profile）是 3GPP TS 31.111 section 7.1.1 定义的特殊短信类型，用于运营商通过 OTA 方式更新 USIM 卡上的数据（如浏览器书签、邮件参数等）。

处理逻辑：

1. 在 `dispatchMessageRadioSpecific()` 中识别 SMS-PP 消息（TP-PID 为特定值）
2. 委托 `UsimDataDownloadHandler.handleUsimDataDownload()` 处理
3. `UsimDataDownloadHandler` 将 PDU 转发给 USIM 应用（通过 CAT/STK 机制）
4. 处理结果通过回调返回，ACK 可能被延迟（等待 SIM 卡响应）

SMS-PP 处理需要 SIM 卡支持 USIM 应用，RUIM 卡不支持。

### 8.4 WAP Push 消息

WAP Push 消息通过特定端口（`PORT_WAP_PUSH` = 2948）发送，最常见的用途是 MMS 通知（MMS Notification）。

在 `processMessagePart()` 中，当 `destPort` 匹配 WAP Push 端口时，处理流程转到 `mWapPush.dispatchWapPdu()`：

```
processMessagePart(tracker)
  -> destPort == PORT_WAP_PUSH
  -> mWapPush.dispatchWapPdu(tracker.mPdu, tracker.mSubId, tracker.mDestPort)
    -> 解析 WAP Push PDU（WspPduConverter）
    -> 提取 Content-Type 和 MMS 通知 URL
    -> 通过 WAP Push 二阶段广播投递：
      -> WAP_PUSH_DELIVER_ACTION -> WAP_PUSH_RECEIVED_ACTION
```

WAP Push 的二阶段广播机制与文本短信类似，Action 分别为 `WAP_PUSH_DELIVER_ACTION` 和 `WAP_PUSH_RECEIVED_ACTION`。

### 8.5 SIM 卡短信（EF_SMS）

部分网络运营商将短信直接存储到 SIM 卡的 EF_SMS 文件，而非通过标准路径下发。这种短信通过 `RIL_UNSOL_RESPONSE_NEW_SMS_ON_SIM` 上报。

处理路径：

```
Modem 上报 RIL_UNSOL_RESPONSE_NEW_SMS_ON_SIM
  -> RadioIndication.newSmsOnSim()
  -> mSmsOnSimRegistrant.notifyRegistrant()
  -> GsmSMSDispatcher (EVENT_NEW_ICC_SMS)
  -> IccRecords.handleSms()
  -> 转发给 GsmInboundSmsHandler 处理
```

SIM 卡短信需要通过 `IccRecords` 读取 EF_SMS 文件内容后，才能获取实际 PDU 数据。

---

## 第 9 章 IMS 短信接收路径对比

### 9.1 ImsSmsDispatcher 在接收路径中的角色

当终端注册 IMS 且支持 SMS over IMS 时，`SmsDispatchersController` 将短信接收路由到 `ImsSmsDispatcher`。与 CS 路径中 Modem 通过 RIL Indication 主动上报不同，IMS 短信通过 `SmsDispatchersController` 的注入机制进入处理流程。

IMS 短信接收的关键差异：

| 特性 | CS 路径 | IMS 路径 |
|------|--------|---------|
| 触发方式 | Modem 主动上报 RIL_UNSOL_RESPONSE_NEW_SMS | `ImsSmsDispatcher.handleInjectSms()` |
| 入口消息 | `EVENT_NEW_SMS` | `EVENT_INJECT_SMS` |
| RIL ACK | 需要调用 `acknowledgeLastIncomingGsmSms()` | 不需要 RIL ACK（IMS 栈自行确认） |
| SmsTracker 标记 | `SOURCE_NOT_INJECTED` | `SOURCE_INJECTED_FROM_IMS` |
| PDU 格式 | 3GPP / 3GPP2 | 取决于 IMS 配置，通常为 3GPP |

### 9.2 IMS 注入短信与 CS 短信的差异

尽管入口不同，IMS 注入短信和 CS 短信最终都进入 `InboundSmsHandler` 状态机的相同处理流程：

- 都经过 `handleNewSms()` -> `dispatchMessage()` -> `dispatchMessageRadioSpecific()`
- 都执行 raw 表写入、去重检测、过滤链、二阶段广播
- 都遵循 StateMachine 的串行化处理规则

主要差异体现在：

- IMS 短信的 `smsSource` 标记为 `SOURCE_INJECTED_FROM_IMS`，用于 Metrics 统计区分
- IMS 短信不需要向 Modem 发送 ACK（IMS 栈的 SIP 层自行处理确认）
- IMS 短信可能携带额外的 `format` 标识信息

---

## 第 10 章 调试与日志

### 10.1 关键 Log TAG

| TAG | 所在类 | 典型日志内容 |
|-----|--------|-------------|
| `GsmInboundSmsHandler` | `GsmInboundSmsHandler.java` | 状态转换、`handleNewSms`、`dispatchMessageRadioSpecific` |
| `InboundSmsHandler` | `InboundSmsHandler.java` | `processMessagePart`、raw 表操作、广播分发 |
| `GsmSMSDispatcher` | `GsmSMSDispatcher.java` | ICC SMS 转发、状态报告处理 |
| `RadioIndication` | `RadioIndication.java` | `newSms`、PDU 接收日志 |
| `RIL` | `RIL.java` | GSM ACK、Registrant 注册 |
| `WapPushOverSms` | `WapPushOverSms.java` | WAP Push 解析与分发 |

### 10.2 常用 adb logcat 过滤命令

```bash
adb logcat -s GsmInboundSmsHandler:V InboundSmsHandler:V RadioIndication:V RIL:V

adb logcat -s GsmInboundSmsHandler:V | grep -E "(transitionTo|enter|exit)"

adb logcat -s InboundSmsHandler:V | grep -E "(dispatchIntent|processMessagePart|SMS_DELIVER|SMS_RECEIVED)"

adb logcat -s RILJ:V | grep -i "newSms"

adb logcat -s WapPushOverSms:V
```

### 10.3 状态机状态查询

```bash
adb shell dumpsys phone | grep -A 20 "InboundSmsHandler"

adb shell content query --uri content://sms/raw

adb shell dumpsys telephony.registry
```

### 10.4 常见问题排查思路

**短信未收到但 Modem 确认下发**

1. 检查 `RadioIndication.newSms()` 日志确认 PDU 是否到达 Framework
2. 检查 `GsmInboundSmsHandler` 日志确认 `EVENT_NEW_SMS` 是否被处理
3. 确认 `InboundSmsHandler` 是否卡在 `StartupState`（`SmsBroadcastUndelivered` 未完成）
4. 检查 `mSmsReceiveDisabled` 是否为 true

**raw 表残留导致短信重复投递**

1. 查询 raw 表：`adb shell content query --uri content://sms/raw`
2. 确认 `deleteFromRawTable()` 是否正常执行
3. 检查 `SmsBroadcastReceiver` 的超时是否触发
4. 手动清理 raw 表：`adb shell content delete --uri content://sms/raw`

**StateMachine 卡在 WaitingState 不恢复**

1. 确认 `EVENT_BROADCAST_COMPLETE` 是否正常发送
2. 检查 `SmsBroadcastReceiver.onReceive()` 是否执行到第二阶段
3. 确认 `EVENT_RECEIVER_TIMEOUT` 超时保护是否生效
4. 检查是否存在广播接收者阻塞（长时间未返回 `setResult()`）

**默认短信应用未正确设置导致广播未送达**

1. 确认 `SmsApplication.getDefaultSmsApplicationAsUser()` 返回非空
2. 检查 `Settings.Secure.getString(SMS_DEFAULT_APPLICATION)` 是否配置
3. 确认默认短信应用持有 `RECEIVE_SMS` 和 `RECEIVE_MMS` 权限
4. 检查设备管理员策略是否限制了默认短信应用的变更

**多部分短信重组失败**

1. 确认所有片段都已到达 raw 表
2. 检查 `getQueryForSegments()` 查询条件是否正确匹配
3. 确认 `referenceNumber` + `address` 在各片段间一致
4. 检查去重逻辑是否误判导致某些片段被覆盖

---

*文档完*