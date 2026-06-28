---
title: "Android 彩信接收与自动下载全流程分析"
date: "2025-06-28"
summary: "从 MMSC 发送 WAP Push 通知到彩信自动下载与持久化的完整流程分析，涵盖 WAP Push over SMS 通知接收、WapPushOverSms 解码分发、MMS 应用通知广播、MmsService 自动下载与 TransactionService 持久化。"
category: "sms"
tags: ["WapPushOverSms", "InboundSmsHandler", "MmsService", "TransactionService", "WapPush", "MMSC", "MMS", "AutoDownload", "PduParser", "SmsBroadcastReceiver"]
featured: true
---

---

## 第1章 概述

### 1.1 彩信接收在 Android Telephony 中的位置

在 Android Telephony 架构中，彩信（MMS）的接收与短信（SMS）的接收共享了从 RIL 到 InboundSmsHandler 的前半段路径，但其核心数据载体并非传统的文本短信，而是 **WAP Push over SMS**。

当发送方向接收方发送一条彩信时，MMSC（MMS 中心）并不会直接通过数据通道推送彩信内容，而是先向接收方发送一条特殊的 SMS 消息——即 **WAP Push 通知消息**（m-notification-ind）。该消息承载于 CS 短信通道（或 IMS 短信通道），其 TP-DATA-CODING 中标识为 WAP 应用端口（PORT_WAP_PUSH = 2948），消息体中携带彩信的下载 URL 等关键元数据。

因此，彩信接收流程可划分为两个阶段：

| 阶段 | 路径 | 说明 |
|------|------|------|
| **前半段（通知接收）** | RIL → Registrant → InboundSmsHandler | 与 CS 短信接收完全共享，WAP Push PDU 作为普通 SMS-DELIVER 被上报和处理 |
| **后半段（下载与持久化）** | WapPushOverSms → 广播分发 → MMS 应用 → MmsService → MMSC | 独立于短信路径，负责 WAP Push 解码、通知广播、自动下载、消息持久化 |

这一架构设计的核心优势在于：**复用了已有的短信接收基础设施**，无需在 RIL/HAL 层为彩信通知引入独立的通道。彩信通知本质上是一条发往特定应用端口的短信，仅在 InboundSmsHandler 层通过目标端口（destPort）进行分流。

### 1.2 整体流程总览

彩信从 Modem 上报到最终下载完成，共涉及 10 个核心步骤，跨越 RIL 层、Telephony 框架层、应用框架层以及 MMS 应用层：

| 步骤 | 层级 | 关键类/方法 | 职责 |
|------|------|------------|------|
| 1 | RIL/HAL | `MessagingIndication.newSms()` | 接收 Modem 上报的 WAP Push PDU（AIDL 路径） |
| 2 | RIL 注册回调 | `mGsmSmsRegistrant.notifyRegistrant()` | Registrant 回调通知 InboundSmsHandler |
| 3 | 状态机入口 | `InboundSmsHandler`（EVENT_NEW_SMS） | 状态机接收消息，从 Idle 状态转入 Delivering 状态 |
| 4 | WAP Push 分流 | `processMessagePart()` | 判断 destPort == PORT_WAP_PUSH，提取 UserData |
| 5 | WAP Push 解码 | `WapPushOverSms.decodeWapPdu()` | 解析 WSP 头部、Content-Type、PDU 类型 |
| 6 | WAP Push 广播 | `WapPushOverSms.dispatchWapPdu()` | 构造 WAP_PUSH_DELIVER_ACTION 有序广播 |
| 7 | 二阶段广播 | `SmsBroadcastReceiver` | 有序广播完成，转为 WAP_PUSH_RECEIVED_ACTION |
| 8 | 应用接收 | `MmsWapPushDeliverReceiver` | 接收广播，解析 m-notification-ind PDU |
| 9 | 自动下载 | `DownloadMmsAction` → `MmsService` | 判断条件（用户设置、数据连接等），触发下载请求 |
| 10 | MMSC 下载 | `DownloadRequest` → `MmsHttpClient` | HTTP GET 获取 m-retrieve-conf，持久化到 MMS 数据库 |

> **注**：步骤 5-10 属于 WAP Push 后半段独立路径，详细分析将在后续章节展开。

### 1.3 关键术语解释

| 术语 | 全称/含义 | 说明 |
|------|----------|------|
| **WAP Push** | Wireless Application Protocol Push | 一种通过 SMS 承载的推送机制，将 WAP 内容（如 MMS 通知、配置消息等）编码为特殊格式的 SMS 发送到指定端口 |
| **m-notification-ind** | MMS Notification Indication | 彩信通知消息，由 MMSC 发出，通过 WAP Push 通道传递，包含彩信的下载 URL、消息大小、过期时间等元数据 |
| **m-retrieve-conf** | MMS Retrieve Confirmation | 彩信实际内容，由接收方通过 HTTP GET 从 MMSC 下载获取的完整彩信 PDU |
| **NotifyRespInd** | Notification Response Indication | 接收方向 MMSC 发送的确认响应，告知 MMSC 接收方已接收通知（Accept/Reject/Deferred） |
| **WapPushCache** | WAP Push 缓存 | 在用户设备未解锁时，暂存 WAP Push 消息的缓存机制，待用户解锁后重新分发 |
| **PORT_WAP_PUSH** | WAP Push 目标端口（2948） | 定义在 `SmsHeader.PORT_WAP_PUSH`，用于在 SMS 传输层标识该短信为 WAP Push 消息，是 InboundSmsHandler 分流的关键判断依据 |
| **WSP** | Wireless Session Protocol | WAP 会话协议，定义了 WAP Push 消息头部的编码格式（Content-Type、Headers 等） |
| **SmsBroadcastReceiver** | SMS 广播结果接收器 | 作为有序广播的 ResultReceiver，负责接收各广播接收者的处理结果并驱动状态机流转 |
| **BugleDatabaseOperations** | Bugle 数据库操作 | AOSP MMS 应用（Bugle）的数据库操作封装类，负责 m-notification-ind 的解析与数据库插入 |

---

## 第2章 RIL Indication 入口

### 2.1 IRadioMessagingIndication 接口（AIDL HAL 接口）

在 Android 现代版本中，RIL 与 Modem 之间通过 AIDL（Android Interface Definition Language）HAL 接口进行通信。彩信通知（WAP Push）作为一条 SMS 消息，由 Modem 通过 `IRadioMessagingIndication` 接口的 `newSms` 方法上报。

`IRadioMessagingIndication` 是 AIDL HAL 接口 `IRadio` 的一部分，专门用于 Messaging 相关的异步指示（Indication）。其主要方法包括：

| 方法 | 功能 |
|------|------|
| `newSms(int indicationType, byte[] pdu)` | Modem 上报新的 SMS-DELIVER（含 WAP Push） |
| `newSmsStatusReport(int indicationType, byte[] pdu)` | Modem 上报 SMS 状态报告 |
| `newBroadcastSms(int indicationType, byte[] data)` | Modem 上报小区广播 SMS |
| `cdmaNewSms(int indicationType, byte[] pdu)` | CDMA 制式的新 SMS 上报 |
| `simSmsStatusReport(int indicationType, byte[] pdu)` | SIM 卡存储的 SMS 状态报告 |

对于 WAP Push over SMS，Modem 将其视为普通 SMS-DELIVER 进行上报，PDU 格式遵循 3GPP TS 27.005（`+CMT:` 格式），以 SMSC 地址开头。PDU 的 TP-DCS 字段标识为 Data Coding Scheme，TP-UD 中包含 WAP Push 的二进制内容。

> **关键点**：RIL 层并不区分普通短信和 WAP Push 短信。在 Modem 和 RIL 层面，WAP Push 仅是一条目标端口为 2948 的普通 SMS。真正的分流逻辑在 InboundSmsHandler 中完成。

### 2.2 MessagingIndication.newSms() 实现（新版 AIDL 路径）

`MessagingIndication` 是 AIDL HAL 接口的 Java 端实现，负责处理 `IRadioMessagingIndication` 的回调。以下是其 `newSms` 方法的完整实现：

```java
// 文件：MessagingIndication.java
/**
 * Indicates when new SMS is received.
 * @param indicationType Type of radio indication
 * @param pdu PDU of SMS-DELIVER represented as byte array.
 *        The PDU starts with the SMSC address per TS 27.005 (+CMT:)
 */
public void newSms(int indicationType, byte[] pdu) {
    mRil.processIndication(HAL_SERVICE_MESSAGING, indicationType);
    if (mRil.isLogOrTrace()) mRil.unsljLog(RIL_UNSOL_RESPONSE_NEW_SMS);

    SmsMessageBase smsb = com.android.internal.telephony.gsm.SmsMessage.createFromPdu(pdu);
    if (mRil.mGsmSmsRegistrant != null) {
        mRil.mGsmSmsRegistrant.notifyRegistrant(
                new AsyncResult(null, smsb == null ? null : new SmsMessage(smsb), null));
    }
}
```

**执行流程解析**：

1. **`mRil.processIndication(HAL_SERVICE_MESSAGING, indicationType)`**：处理 Indication 类型（UNSOL、UNSOL_ACK 等），用于 RIL 与 HAL 之间的流控。

2. **`SmsMessage.createFromPdu(pdu)`**：将原始 PDU 字节数组解析为 `SmsMessageBase` 对象。此时仅完成 PDU 的基本解析（SMSC、TP-OA、TP-PID、TP-DCS、TP-SCTS 等头部字段），**不涉及 WAP Push 的解码**。WAP Push 的 UserData 作为原始字节保留在 SmsMessage 对象中。

3. **`mGsmSmsRegistrant.notifyRegistrant()`**：通过 Registrant 回调机制，将解析后的 `SmsMessage` 对象包装在 `AsyncResult` 中，发送给注册的 Handler（即 `InboundSmsHandler`）。

> **注意**：此处将 `SmsMessageBase` 包装为 `SmsMessage`（com.android.internal.telephony.gsm.SmsMessage），这是 GSM 制式的包装类。对于 CDMA 制式的 WAP Push，走 `cdmaNewSms` 方法。

### 2.3 RadioIndication.newSms() 实现（旧版 HIDL 路径）

`RadioIndication` 是旧版 HIDL HAL 接口的 Java 端实现，用于兼容仍使用 HIDL 接口的 Modem 实现。以下是其 `newSms` 方法：

```java
// 文件：RadioIndication.java
public void newSms(int indicationType, ArrayList<Byte> pdu) {
    mRil.processIndication(HAL_SERVICE_RADIO, indicationType);

    byte[] pduArray = RILUtils.arrayListToPrimitiveArray(pdu);
    if (mRil.isLogOrTrace()) mRil.unsljLog(RIL_UNSOL_RESPONSE_NEW_SMS);

    SmsMessageBase smsb = com.android.internal.telephony.gsm.SmsMessage.createFromPdu(pduArray);
    if (mRil.mGsmSmsRegistrant != null) {
        mRil.mGsmSmsRegistrant.notifyRegistrant(
                new AsyncResult(null, smsb == null ? null : new SmsMessage(smsb), null));
    }
}
```

**与 AIDL 路径的核心差异**：

- PDU 参数类型为 `ArrayList<Byte>`（HIDL 特有），需通过 `RILUtils.arrayListToPrimitiveArray()` 转换为 `byte[]`。
- `processIndication` 的服务标识为 `HAL_SERVICE_RADIO`（而非 `HAL_SERVICE_MESSAGING`），因为 HIDL 架构中 Messaging 指示统一走 Radio 接口。
- 后续的 PDU 解析和 Registrant 回调逻辑与 AIDL 路径完全一致。

### 2.4 两条路径的差异对比

| 对比维度 | AIDL 路径（MessagingIndication） | HIDL 路径（RadioIndication） |
|---------|----------------------------------|------------------------------|
| **HAL 接口** | `IRadioMessagingIndication` (AIDL) | `IRadioIndication` (HIDL) |
| **服务标识** | `HAL_SERVICE_MESSAGING` | `HAL_SERVICE_RADIO` |
| **PDU 参数类型** | `byte[] pdu` | `ArrayList<Byte> pdu` |
| **类型转换** | 无需转换，直接使用 | `RILUtils.arrayListToPrimitiveArray()` |
| **Registrant** | `mGsmSmsRegistrant` | `mGsmSmsRegistrant` |
| **PDU 解析** | `SmsMessage.createFromPdu(pdu)` | `SmsMessage.createFromPdu(pduArray)` |
| **适用场景** | Android 12+ 新架构 | 兼容旧版 Modem |

> 两条路径在完成 PDU 解析后完全汇聚，后续处理逻辑（Registrant 回调 → InboundSmsHandler）无任何差异。

### 2.5 GSM/CDMA Registrant 回调机制

RIL Indication 层通过 Registrant 机制将解析后的 SMS 消息传递给 InboundSmsHandler。Registrant 是 Android Telephony 中经典的观察者模式实现：

**回调链路**：

1. **Registrant 注册**：`InboundSmsHandler` 在构造时通过 `RIL.mGsmSmsRegistrant` 注册回调 Handler。
2. **通知触发**：`mGsmSmsRegistrant.notifyRegistrant(new AsyncResult(null, smsMessage, null))` 被调用。
3. **消息投递**：Registrant 内部将 `smsMessage` 包装为 `Message` 对象（what = `EVENT_NEW_SMS`），投递到 `InboundSmsHandler` 的 Handler 队列。
4. **状态机处理**：`InboundSmsHandler` 在 `DeliveringState` 中处理 `EVENT_NEW_SMS` 消息。

```java
// InboundSmsHandler.java - DeliveringState
case EVENT_NEW_SMS:
    // handle new SMS from RIL
    handleNewSms((AsyncResult) msg.obj);
    sendMessage(EVENT_RETURN_TO_IDLE);
    return HANDLED;
```

**关于 EVENT_NEW_SMS 消息**：

| 属性 | 值 |
|------|----|
| 消息类型 | `EVENT_NEW_SMS` |
| 消息内容（msg.obj） | `AsyncResult` 对象，result 字段为 `SmsMessage` |
| 处理状态 | `DeliveringState.processMessage()` |
| 处理方法 | `handleNewSms()` → `dispatchMessage()` → `dispatchNormalMessage()` |

> **注意**：无论是普通文本短信还是 WAP Push 短信，在 RIL 层和 Registrant 层面均走同一条路径（`EVENT_NEW_SMS`），**不进行任何区分**。直到 `dispatchNormalMessage()` → `processMessagePart()` 阶段才根据 `destPort` 进行分流。

### 2.6 入口调用链完整描述

从 Modem 上报到 InboundSmsHandler 接收，完整的调用链如下：

```
Modem
  └─── IRadio.newSms() / IRadioIndication.newSms()        [AIDL/HIDL HAL 接口]
        └─── MessagingIndication.newSms() / RadioIndication.newSms()   [Java 端实现]
              └─── SmsMessage.createFromPdu(pdu)             [PDU 解析为 SmsMessageBase]
              └─── mGsmSmsRegistrant.notifyRegistrant()     [Registrant 回调]
                    └─── AsyncResult(result=SmsMessage)       [封装结果]
                    └─── InboundSmsHandler.handleMessage()     [Handler 投递]
                          └─── EVENT_NEW_SMS                  [消息类型]
                          └─── IdleState → deferMessage → transitionTo(DeliveringState)
                          └─── DeliveringState.processMessage()
                                └─── handleNewSms(ar)
                                      └─── dispatchMessage(sms.mWrappedSmsMessage, SOURCE_NOT_INJECTED, 0)
                                            └─── dispatchMessageRadioSpecific()   [子类实现]
                                                  └─── dispatchNormalMessage()       [端口提取 + Tracker 创建]
                                                        └─── addTrackerToRawTableAndSendMessage()
                                                              └─── EVENT_BROADCAST_SMS
```

**关键状态转换**：
- 状态机初始处于 **IdleState**
- 收到 `EVENT_NEW_SMS` 后，`IdleState` 将消息 **defer**（延迟）并转换到 `DeliveringState`
- `DeliveringState` 处理延迟的 `EVENT_NEW_SMS`，调用 `handleNewSms()`
- 处理完成后发送 `EVENT_RETURN_TO_IDLE`，状态机回到 `IdleState`（释放 WakeLock）

---

## 第3章 InboundSmsHandler WAP Push 分流

### 3.1 InboundSmsHandler 状态机回顾

`InboundSmsHandler` 是一个分层状态机（Hierarchical StateMachine），包含 5 个状态，其中 4 个为有效处理状态，1 个为父状态。状态层级关系如下：

```
DefaultState                    [异常消息处理的兜底状态]
├── StartupState                [启动状态，等待 SmsBroadcastUndelivered 完成]
├── IdleState                   [空闲状态，等待新消息]
├── DeliveringState             [投递状态，处理 SMS 消息并存储到 raw 表]
│   └── WaitingState            [等待状态，等待有序广播完成]
```

**状态转换表**：

| 当前状态 | 触发事件 | 动作 | 目标状态 |
|---------|---------|------|---------|
| StartupState | SmsBroadcastUndelivered 完成 | 初始广播处理完毕 | IdleState |
| IdleState | EVENT_NEW_SMS / EVENT_INJECT_SMS / EVENT_BROADCAST_SMS | deferMessage，获取 WakeLock | DeliveringState |
| IdleState | EVENT_RELEASE_WAKELOCK（延迟 3s） | 释放 WakeLock | 保持 IdleState |
| DeliveringState | EVENT_NEW_SMS | handleNewSms() | 发送 EVENT_RETURN_TO_IDLE |
| DeliveringState | EVENT_BROADCAST_SMS + processMessagePart 返回 true | 广播已发送 | WaitingState |
| DeliveringState | EVENT_BROADCAST_SMS + processMessagePart 返回 false | 无广播发送 | IdleState |
| DeliveringState | EVENT_RETURN_TO_IDLE | 处理完成 | IdleState |
| WaitingState | EVENT_BROADCAST_COMPLETE | 当前广播完成 | DeliveringState（处理下一条延迟消息） |
| WaitingState | EVENT_RETURN_TO_IDLE | 所有消息处理完毕 | IdleState |

**初始状态**为 `StartupState`，在此期间状态机等待 `SmsBroadcastUndelivered` 完成对上次关机期间未投递消息的重试。完成后转换到 `IdleState`，开始正常接收消息。

**代码实现**（状态注册）：

```java
// InboundSmsHandler.java - 构造函数
addState(mDefaultState);
addState(mStartupState, mDefaultState);
addState(mIdleState, mDefaultState);
addState(mDeliveringState, mDefaultState);
    addState(mWaitingState, mDeliveringState);

setInitialState(mStartupState);
```

### 3.2 dispatchMessage() 中的端口判断

`dispatchMessage()` 是 InboundSmsHandler 处理 SMS 消息的核心入口方法。它执行前置检查后调用子类的 `dispatchMessageRadioSpecific()`，后者再调用共享的 `dispatchNormalMessage()` 进行端口提取：

```java
// InboundSmsHandler.java
private int dispatchMessage(SmsMessageBase smsb, @SmsSource int smsSource, int token) {
    if (smsb == null) {
        loge("dispatchSmsMessage: message is null");
        return RESULT_SMS_NULL_MESSAGE;
    }

    if (mSmsReceiveDisabled) {
        log("Received short message on device which doesn't support "
                + "receiving SMS. Ignored.");
        return Intents.RESULT_SMS_HANDLED;
    }

    // ... 卫星会话等前置检查 ...

    int result = dispatchMessageRadioSpecific(smsb, smsSource, token);
    // ... 错误指标记录 ...
    return result;
}
```

`dispatchNormalMessage()` 从 SMS 消息的 UserData Header（UDH）中提取目标端口：

```java
// InboundSmsHandler.java
protected int dispatchNormalMessage(SmsMessageBase sms, @SmsSource int smsSource) {
    SmsHeader smsHeader = sms.getUserDataHeader();
    InboundSmsTracker tracker;

    if ((smsHeader == null) || (smsHeader.concatRef == null)) {
        // 单条消息（非长短信拼接）
        int destPort = -1;
        if (smsHeader != null && smsHeader.portAddrs != null) {
            // 消息发送到特定端口
            destPort = smsHeader.portAddrs.destPort;
            if (DBG) log("destination port: " + destPort);
        }
        tracker = TelephonyComponentFactory.getInstance()
                .inject(InboundSmsTracker.class.getName())
                .makeInboundSmsTracker(mContext, sms.getPdu(),
                        sms.getTimestampMillis(), destPort, is3gpp2(), false,
                        sms.getOriginatingAddress(), sms.getDisplayOriginatingAddress(),
                        sms.getMessageBody(), sms.getMessageClass() == MessageClass.CLASS_0,
                        mPhone.getSubId(), smsSource);
    } else {
        // 长短信拼接消息
        SmsHeader.ConcatRef concatRef = smsHeader.concatRef;
        SmsHeader.PortAddrs portAddrs = smsHeader.portAddrs;
        int destPort = (portAddrs != null ? portAddrs.destPort : -1);
        tracker = TelephonyComponentFactory.getInstance()
                .inject(InboundSmsTracker.class.getName())
                .makeInboundSmsTracker(mContext, sms.getPdu(),
                        sms.getTimestampMillis(), destPort, is3gpp2(),
                        sms.getOriginatingAddress(), sms.getDisplayOriginatingAddress(),
                        concatRef.refNumber, concatRef.seqNumber, concatRef.msgCount, false,
                        sms.getMessageBody(), sms.getMessageClass() == MessageClass.CLASS_0,
                        mPhone.getSubId(), smsSource);
    }
    return addTrackerToRawTableAndSendMessage(tracker,
            tracker.getDestPort() == -1 /* de-dup if text message */);
}
```

**端口提取逻辑要点**：

1. **获取 UserDataHeader**：通过 `sms.getUserDataHeader()` 获取 UDH（User Data Header），其中包含端口地址信息。
2. **提取 destPort**：从 `smsHeader.portAddrs.destPort` 读取目标端口号。对于 WAP Push 消息，该值为 **2948**（`SmsHeader.PORT_WAP_PUSH`）。
3. **封装 InboundSmsTracker**：将 destPort、PDU、时间戳、来源地址等信息封装为 `InboundSmsTracker` 对象。
4. **去重策略**：`destPort == -1` 的消息（即普通文本短信）启用去重检查；WAP Push 消息（`destPort == 2948`）**不进行去重**。

> **关键**：端口判断并非在 `dispatchMessage` 或 `dispatchNormalMessage` 中直接执行分流，而是将 `destPort` 信息封装到 `InboundSmsTracker` 中，后续在 `processMessagePart()` 中才根据该值判断是否为 WAP Push。

### 3.3 processMessagePart() WAP Push 分支核心代码

`processMessagePart()` 是 InboundSmsHandler 中执行实际分流的核心方法。当状态机处理 `EVENT_BROADCAST_SMS` 时，调用此方法。其 WAP Push 分支的关键逻辑如下：

```java
// InboundSmsHandler.java - processMessagePart()
final boolean isWapPush = (destPort == SmsHeader.PORT_WAP_PUSH);
String format = tracker.getFormat();

// ... PDU 空值检查 ...

ByteArrayOutputStream output = new ByteArrayOutputStream();
if (isWapPush) {
    for (byte[] pdu : pdus) {
        // 3GPP needs to extract the User Data from the PDU;
        // 3GPP2 has already done this
        if (format == SmsConstants.FORMAT_3GPP) {
            SmsMessage msg = SmsMessage.createFromPdu(pdu, SmsConstants.FORMAT_3GPP);
            if (msg != null) {
                pdu = msg.getUserData();
            } else {
                loge("processMessagePart: SmsMessage.createFromPdu returned null",
                        tracker.getMessageId());
                mPhone.getSmsStats().onIncomingSmsWapPush(tracker.getSource(),
                        messageCount, RESULT_SMS_NULL_MESSAGE, tracker.getMessageId(),
                        isEmergencyNumber(tracker.getAddress()), 0);
                return false;
            }
        }
        output.write(pdu, 0, pdu.length);
    }
}

SmsBroadcastReceiver resultReceiver = tracker.getSmsBroadcastReceiver(this);

// ... 用户未解锁时的处理 ...

if (isWapPush) {
    int result = mWapPush.dispatchWapPdu(output.toByteArray(), resultReceiver,
            this, address, tracker.getSubId(), tracker.getMessageId());
    if (DBG) {
        log("processMessagePart: dispatchWapPdu() returned " + result,
                tracker.getMessageId());
    }
    boolean wapPushResult =
            result == Activity.RESULT_OK || result == Intents.RESULT_SMS_HANDLED;
    int pduLength = wapPushResult ? output.size() : 0;
    mPhone.getSmsStats().onIncomingSmsWapPush(tracker.getSource(), messageCount,
            result, tracker.getMessageId(), isEmergencyNumber(tracker.getAddress()),
            pduLength);
    if (result == Activity.RESULT_OK) {
        return true;
    } else {
        deleteFromRawTable(tracker.getDeleteWhere(), tracker.getDeleteWhereArgs(),
                MARK_DELETED);
        loge("processMessagePart: returning false as the ordered broadcast for WAP push "
                + "was not sent", tracker.getMessageId());
        return false;
    }
}

// 以下为普通短信的处理逻辑（WAP Push 不会执行到此处）
// ...
```

**WAP Push 分支执行流程**：

1. **判断 `isWapPush`**：通过 `destPort == SmsHeader.PORT_WAP_PUSH`（2948）判断当前消息是否为 WAP Push。

2. **提取 UserData**（仅 3GPP）：
   - 对于 3GPP 格式，需再次调用 `SmsMessage.createFromPdu()` 解析 PDU，然后通过 `getUserData()` 提取纯 UserData 字节（剥离 SMSC 和 TP 层头部）。
   - 对于 3GPP2 格式，PDU 已在之前的解析阶段完成了 UserData 提取，无需额外处理。
   - 多段 PDU（长短信拼接场景）通过 `ByteArrayOutputStream` 合并为一个完整的字节数组。

3. **调用 `dispatchWapPdu()`**：将提取的 UserData 字节传递给 `WapPushOverSms.dispatchWapPdu()` 进行后续的 WAP Push 解码和广播分发。

4. **结果处理**：
   - `RESULT_OK`：有序广播已成功发送，返回 `true`，状态机转入 `WaitingState`。
   - 其他结果：广播发送失败，从 raw 表中删除该 Tracker，返回 `false`。

### 3.4 3GPP PDU 提取 UserData 的特殊处理

3GPP 和 3GPP2 在 PDU 结构上存在显著差异，这导致 WAP Push UserData 的提取方式不同：

| 制式 | PDU 结构 | UserData 提取方式 |
|------|---------|-------------------|
| **3GPP** | `[SMSC][TPDU]`，UserData 嵌在 TPDU 内部，需根据 TP-DCS 解码 | `SmsMessage.createFromPdu(pdu)` → `getUserData()` |
| **3GPP2** | UserData 已由 `CdmaSMSMessage` 在 RIL 解析阶段完成提取 | 直接使用 `byte[] pdu`，无需额外处理 |

**3GPP 的二次解析原因**：

在 `MessagingIndication.newSms()` 阶段，`SmsMessage.createFromPdu()` 已完成了一次 PDU 解析，生成 `SmsMessageBase` 对象。但此时传递给 `InboundSmsTracker` 的 `pdus` 字段存储的是**原始 PDU 字节**（从 `sms.getPdu()` 获取），而非提取后的 UserData。因此在 `processMessagePart()` 中需要再次调用 `createFromPdu()` 进行解析，然后调用 `getUserData()` 提取 WAP Push 的二进制内容。

**代码中的关键区分逻辑**：

```java
if (format == SmsConstants.FORMAT_3GPP) {
    SmsMessage msg = SmsMessage.createFromPdu(pdu, SmsConstants.FORMAT_3GPP);
    if (msg != null) {
        pdu = msg.getUserData();  // 剥离 TP 层，提取纯 WAP Push 二进制数据
    }
}
output.write(pdu, 0, pdu.length);
```

提取后的 `output.toByteArray()` 即为完整的 WAP Push 二进制内容，包含 WSP 头部和消息体（m-notification-ind XML），可直接传递给 `WapPushOverSms` 进行解码。

### 3.5 WapPushOverSms.dispatchWapPdu() 调用时机

`mWapPush.dispatchWapPdu()` 的调用发生在 `processMessagePart()` 内部，且**仅在 `isWapPush == true` 时执行**。其调用位置在状态机的 `DeliveringState` 中：

```
DeliveringState.processMessage(EVENT_BROADCAST_SMS)
  └── processMessagePart(tracker)
        ├── [前置检查] PDU 空值检查、拼接完成检查、去重检查
        ├── [UserData 提取] 3GPP 二次解析，合并多段 PDU
        ├── [用户锁定检查] isMainUserUnlocked() → processMessagePartWithUserLocked()
        └── [WAP Push 分流]
              ├── isWapPush == true  → mWapPush.dispatchWapPdu(output, resultReceiver, ...)
              └── isWapPush == false → filterSms() → dispatchSmsDeliveryIntent()
```

**`dispatchWapPdu()` 方法签名**：

```java
int dispatchWapPdu(byte[] pdu, SmsBroadcastReceiver resultReceiver,
        InboundSmsHandler handler, String address, int subId, long messageId)
```

| 参数 | 说明 |
|------|------|
| `pdu` | WAP Push 二进制数据（WSP 头部 + 消息体） |
| `resultReceiver` | 广播结果接收器，用于状态机流转 |
| `handler` | InboundSmsHandler 引用 |
| `address` | 发送方地址 |
| `subId` | SIM 卡订阅 ID |
| `messageId` | 消息追踪 ID |

**调用时序关键点**：

1. **WakeLock 已持有**：在 `IdleState.exit()` 中已获取 WakeLock，保证设备不会在 WAP Push 处理过程中休眠。

2. **PDU 已存储到 raw 表**：在 `addTrackerToRawTableAndSendMessage()` 阶段，PDU 数据已写入 `raw` 表（` SmsProvider` 的 `raw` 表），用于异常恢复。

3. **状态机转换**：若 `dispatchWapPdu()` 返回 `RESULT_OK`，`processMessagePart()` 返回 `true`，`DeliveringState` 将状态机转入 `WaitingState` 等待有序广播完成。

4. **异常处理**：若 `dispatchWapPdu()` 返回非 `RESULT_OK`，PDU 将从 raw 表中删除，`processMessagePart()` 返回 `false`，状态机回到 `IdleState`。

> **总结**：`WapPushOverSms.dispatchWapPdu()` 是 WAP Push 处理的转折点。在此之前，所有处理逻辑与普通短信完全共享；在此之后，流程进入独立的 WAP Push 解码、广播分发、MMS 下载路径，不再经过 InboundSmsHandler 的普通短信处理流程。

---

## 第4章 WapPushOverSms 解码与分发

### 4.1 WapPushOverSms 类概览

`WapPushOverSms` 是 Android Telephony 框架中负责处理 WAP Push 消息的核心类。该类将底层 RIL 上报的二进制 WAP Push PDU 数据解码为结构化对象，并构造 Intent 广播分发给上层 MMS 应用。

**源码路径**：`telephony/src/java/com/android/internal/telephony/WapPushOverSms.java`

**类声明与核心职责**：

```java
public class WapPushOverSms implements ServiceConnection {
    private static final String TAG = "WAP PUSH";

    private final Context mContext;
    private UserManager mUserManager;
    PowerWhitelistManager mPowerWhitelistManager;
    protected final @NonNull FeatureFlags mFeatureFlags;
    private String mWapPushManagerPackage;
    private volatile IWapPushManager mWapPushManager;
    // ...
}
```

| 职责 | 说明 |
|------|------|
| WAP PDU 解码 | 将原始二进制 WSP PDU 解析为 `DecodedResult`，提取 Content-Type、Header、Body 等 |
| MMS Notification 识别 | 通过 `PduParser` 识别 `MESSAGE_TYPE_NOTIFICATION_IND`，触发缓存与拦截逻辑 |
| WapPushManager 代理 | 若存在 `IWapPushManager` 服务，优先委托其处理特定 Application ID 的消息 |
| Intent 广播构造 | 构造 `WAP_PUSH_DELIVER_ACTION` Intent，定向发送到默认 MMS 应用 |
| 权限映射 | 根据 MIME 类型返回对应的 Android 权限和 AppOps 字符串 |

**核心成员变量**：

| 成员变量 | 类型 | 说明 |
|----------|------|------|
| `mContext` | `Context` | Telephony 进程上下文 |
| `mUserManager` | `UserManager` | 用于获取主用户 Handle |
| `mPowerWhitelistManager` | `PowerWhitelistManager` | 临时白名单管理，确保 MMS 应用不被后台限制 |
| `mWapPushManager` | `IWapPushManager` | 可选的 WAP Push 管理服务（通过 `bindService` 绑定） |
| `mFeatureFlags` | `FeatureFlags` | AOSP Feature Flags 控制实验性功能 |

**内部类 `DecodedResult`** —— 解码结果的封装容器：

```java
private final class DecodedResult {
    String mimeType;                    // 解码后的 MIME 类型
    String contentType;                 // 原始 Content-Type
    int transactionId;                  // WSP 事务 ID
    int pduType;                        // PDU 类型（PUSH / CONFIRMED_PUSH）
    int phoneId;                        // 电话设备 ID
    int subId;                          // SIM 卡订阅 ID
    byte[] header;                      // WSP 头部原始字节
    String wapAppId;                    // x-wap-application-id
    byte[] intentData;                  // 消息体（去掉 WSP 头部后的数据）
    HashMap<String, String> contentTypeParameters; // Content-Type 参数
    GenericPdu parsedPdu;               // PduParser 解析后的 PDU 对象
    int statusCode;                     // 解码状态码
}
```

### 4.2 decodeWapPdu() 解码流程

`decodeWapPdu()` 是 WAP Push 消息解码的核心方法，负责将原始 WSP PDU 字节流解析为 `DecodedResult` 对象。该方法严格遵循 **WAP-230-WSP-20010705-a** 规范。

**方法签名**：

```java
private DecodedResult decodeWapPdu(byte[] pdu, InboundSmsHandler handler)
```

**返回值状态码**：

| 状态码 | 含义 |
|--------|------|
| `Activity.RESULT_OK` | 解码成功，应继续处理 |
| `Intents.RESULT_SMS_HANDLED` | 非 PUSH 类型 PDU，应忽略 |
| `Intents.RESULT_SMS_GENERIC_ERROR` | PDU 格式无效 |

**完整解码流程**：

```
decodeWapPdu(byte[] pdu, InboundSmsHandler handler)
  │
  ├── 1. 解析 transactionId 和 pduType（PDU[0]、PDU[1]）
  │     └── 校验 PDU_TYPE_PUSH / PDU_TYPE_CONFIRMED_PUSH
  │           ├── 校验失败 → 尝试 config_valid_wappush_index 偏移重试
  │           └── 最终失败 → return RESULT_SMS_HANDLED
  │
  ├── 2. 解析 HeaderLen（uintvar 编码，最多 5 字节）
  │     └── 基于 Wap-230-WSP section 8.1.2
  │
  ├── 3. 解析 Content-Type
  │     └── 支持 Constrained-media 和 Content-general-form
  │
  ├── 4. 提取 header 和 intentData
  │     ├── header = pdu[headerStartIndex .. headerStartIndex + headerLength]
  │     └── intentData = pdu[dataIndex .. end]
  │           └── 特例：CONTENT_TYPE_B_PUSH_CO 时，intentData = 整个 pdu
  │
  ├── 5. PduParser 解析 → MESSAGE_TYPE_NOTIFICATION_IND 识别
  │     ├── parsedPdu = PduParser.parse(intentData)
  │     ├── 若为 NotificationInd → WapPushCache.putWapMessageSize()
  │     └── BlockChecker 拦截检查
  │
  ├── 6. 提取 Application ID（x-wap-application-id）
  │     └── seekXWapApplicationId() → decodeXWapApplicationId()
  │
  └── 7. 填充 DecodedResult，返回 RESULT_OK
```

#### 4.2.1 transactionId 与 pduType 解析

WSP PDU 的前两个字节分别是 **Transaction ID** 和 **PDU Type**：

```java
int index = 0;
int transactionId = pdu[index++] & 0xFF;    // 第1字节：事务 ID
int pduType = pdu[index++] & 0xFF;          // 第2字节：PDU 类型
```

**PDU Type 校验逻辑**：

```java
if ((pduType != WspTypeDecoder.PDU_TYPE_PUSH)
        && (pduType != WspTypeDecoder.PDU_TYPE_CONFIRMED_PUSH)) {
    // 尝试通过 config_valid_wappush_index 资源配置的偏移量重试
    index = mContext.getResources().getInteger(
            com.android.internal.R.integer.config_valid_wappush_index);
    if (index != -1) {
        transactionId = pdu[index++] & 0xff;
        pduType = pdu[index++] & 0xff;
        // 再次校验 ...
    } else {
        // 无有效偏移量配置，返回 HANDLED（忽略此消息）
        result.statusCode = Intents.RESULT_SMS_HANDLED;
        return result;
    }
}
```

> **设计说明**：`config_valid_wappush_index` 是运营商自定义配置项。某些运营商的 WAP PDU 在标准偏移之外存放实际的 Transaction ID 和 PDU Type，此机制提供了兼容性支持。

#### 4.2.2 HeaderLen 解析（uintvar 编码）

```java
WspTypeDecoder pduDecoder = TelephonyComponentFactory.getInstance()
        .inject(WspTypeDecoder.class.getName())
        .makeWspTypeDecoder(pdu);

/**
 * Parse HeaderLen(unsigned integer).
 * From wap-230-wsp-20010705-a section 8.1.2
 * The maximum size of a uintvar is 32 bits.
 * So it will be encoded in no more than 5 octets.
 */
if (pduDecoder.decodeUintvarInteger(index) == false) {
    result.statusCode = Intents.RESULT_SMS_GENERIC_ERROR;
    return result;
}
int headerLength = (int) pduDecoder.getValue32();
index += pduDecoder.getDecodedDataLength();
```

**uintvar 编码规则**（WAP 规范 Section 8.1.2）：

| 编码格式 | 说明 |
|----------|------|
| 每字节最高位 | `0` 表示最后一个字节，`1` 表示后续还有字节 |
| 最大长度 | 5 字节（32 位值） |
| 实际值 | 各字节低 7 位拼接 |

#### 4.2.3 Content-Type 解析与 MIME 类型识别

```java
/**
 * Parse Content-Type.
 * From wap-230-wsp-20010705-a section 8.4.2.24
 * Content-type-value = Constrained-media | Content-general-form
 */
if (pduDecoder.decodeContentType(index) == false) {
    result.statusCode = Intents.RESULT_SMS_GENERIC_ERROR;
    return result;
}

String mimeType = pduDecoder.getValueString();       // 如 "application/vnd.wap.mms-message"
long binaryContentType = pduDecoder.getValue32();     // 如 0x3A（Well-known 编码）
index += pduDecoder.getDecodedDataLength();
```

**MMS 相关的 MIME 类型**：

| MIME 类型 | 二进制值 | 说明 |
|-----------|----------|------|
| `application/vnd.wap.mms-message` | `CONTENT_TYPE_B_MMS` (0x3A) | 标准 MMS WAP Push |
| `application/vnd.wap.mms-message`（使用 content-location 头） | 取决于头部字段 | MMS 通知 |

#### 4.2.4 header 和 intentData 提取

```java
int headerStartIndex = index;

byte[] header = new byte[headerLength];
System.arraycopy(pdu, headerStartIndex, header, 0, header.length);

byte[] intentData;

if (mimeType != null && mimeType.equals(WspTypeDecoder.CONTENT_TYPE_B_PUSH_CO)) {
    // 特殊情况：CONTENT_TYPE_B_PUSH_CO 携带完整 PDU 数据
    intentData = pdu;
} else {
    // 标准情况：intentData 仅包含消息体（去掉 WSP 头部）
    int dataIndex = headerStartIndex + headerLength;
    intentData = new byte[pdu.length - dataIndex];
    System.arraycopy(pdu, dataIndex, intentData, 0, intentData.length);
}
```

**数据结构示意**：

```
WAP Push PDU 整体结构：
┌──────────┬──────────┬───────────────────┬──────────────────┐
│ TID(1B)  │ Type(1B) │ WSP Header(N字节)  │ Body(M字节)       │
└──────────┴──────────┴───────────────────┴──────────────────┘
                          ↓                       ↓
                       header[]              intentData[]
```

#### 4.2.5 PDU 解析（PduParser）与 MESSAGE_TYPE_NOTIFICATION_IND 识别

```java
// Continue if PDU parsing fails: the default messaging app may successfully parse
// the same PDU.
GenericPdu parsedPdu = null;
try {
    parsedPdu = new PduParser(intentData, shouldParseContentDisposition(subId)).parse();
} catch (Exception e) {
    Rlog.e(TAG, "Unable to parse PDU: " + e.toString());
}

if (parsedPdu != null && parsedPdu.getMessageType() == MESSAGE_TYPE_NOTIFICATION_IND) {
    final NotificationInd nInd = (NotificationInd) parsedPdu;
    // 缓存消息大小，供卫星连接场景下的下载阈值判断
    WapPushCache.putWapMessageSize(
            nInd.getContentLocation(),
            nInd.getTransactionId(),
            nInd.getMessageSize()
    );
    // 拦截检查：若发送方在黑名单中，直接忽略
    if (nInd.getFrom() != null
            && BlockChecker.isBlocked(mContext, nInd.getFrom().getString(), null)) {
        result.statusCode = Intents.RESULT_SMS_HANDLED;
        return result;
    }
}
```

> **容错设计**：即使 `PduParser.parse()` 抛出异常，方法也不会中断。框架层允许将原始 PDU 数据透传给默认 MMS 应用，由应用层自行完成解析。这是因为框架层的 PDU 解析可能不如某些厂商 MMS 应用的解析器兼容性好。

#### 4.2.6 WapPushCache 缓存消息大小

对于 `MESSAGE_TYPE_NOTIFICATION_IND` 类型的 MMS 通知，`decodeWapPdu()` 会将消息的关键元数据（Content-Location、Transaction-Id、Message-Size）缓存到 `WapPushCache`：

```java
WapPushCache.putWapMessageSize(
        nInd.getContentLocation(),   // MMS 下载 URL
        nInd.getTransactionId(),     // MMS 事务 ID
        nInd.getMessageSize()        // MMS 消息大小（字节数）
);
```

此缓存的目的是：当设备处于**卫星连接**等受限网络环境时，系统可以在 MMS 自动下载前检查消息大小是否在可接受阈值内，避免不必要的卫星流量消耗。

#### 4.2.7 Application ID（x-wap-application-id）提取

```java
/**
 * Seek for application ID field in WSP header.
 * If application ID is found, WapPushManager substitute the message
 * processing.
 */
if (pduDecoder.seekXWapApplicationId(index, index + headerLength - 1)) {
    index = (int) pduDecoder.getValue32();
    pduDecoder.decodeXWapApplicationId(index);
    String wapAppId = pduDecoder.getValueString();
    if (wapAppId == null) {
        wapAppId = Integer.toString((int) pduDecoder.getValue32());
    }
    result.wapAppId = wapAppId;
    String contentType = ((mimeType == null)
            ? Long.toString(binaryContentType) : mimeType);
    result.contentType = contentType;
}
```

Application ID 的作用是让 `WapPushManager`（可选系统服务）决定是否拦截此消息。若 `WapPushManager` 存在且处理了该消息（返回 `MESSAGE_HANDLED` 且不包含 `FURTHER_PROCESSING` 标志），则后续的默认 MMS 应用分发逻辑将被跳过。

### 4.3 dispatchWapPdu() 广播构造

`dispatchWapPdu()` 是 `decodeWapPdu()` 的下游方法，负责将解码结果转化为 Android 广播 Intent 并分发。该方法由 `InboundSmsHandler.processMessagePart()` 在 WAP Push 分流路径中调用。

**方法签名**：

```java
public int dispatchWapPdu(byte[] pdu, InboundSmsHandler.SmsBroadcastReceiver receiver,
        InboundSmsHandler handler, String address, int subId, long messageId)
```

**核心执行流程**：

```
dispatchWapPdu()
  │
  ├── 1. decodeWapPdu() → 若失败直接返回 statusCode
  │
  ├── 2. WapPushManager 拦截检查
  │     ├── wapAppId != null → wapPushMan.processMessage()
  │     └── MESSAGE_HANDLED && !FURTHER_PROCESSING → return RESULT_SMS_HANDLED
  │
  ├── 3. mimeType 空值检查
  │
  ├── 4. 构造 Intent（WAP_PUSH_DELIVER_ACTION）
  │     ├── setType(result.mimeType)  → "application/vnd.wap.mms-message"
  │     ├── putExtra("transactionId")
  │     ├── putExtra("pduType")
  │     ├── putExtra("header")
  │     ├── putExtra("data", result.intentData)
  │     └── putExtra("address", address)
  │
  ├── 5. 定向发送到默认 MMS 应用
  │     ├── SmsApplication.getDefaultMmsApplicationAsUser()
  │     ├── intent.setComponent(componentName)
  │     └── PowerWhitelistManager 临时白名单
  │
  └── 6. handler.dispatchIntent() 发送有序广播
        └── return Activity.RESULT_OK
```

#### 4.3.1 Intent 构造

```java
Intent intent = new Intent(Intents.WAP_PUSH_DELIVER_ACTION);
intent.setType(result.mimeType);     // "application/vnd.wap.mms-message"
intent.putExtra("transactionId", result.transactionId);
intent.putExtra("pduType", result.pduType);
intent.putExtra("header", result.header);
intent.putExtra("data", result.intentData);
intent.putExtra("contentTypeParameters", result.contentTypeParameters);
if (!TextUtils.isEmpty(address)) {
    intent.putExtra("address", address);
}
if (messageId != 0L) {
    intent.putExtra("messageId", messageId);
}
```

**Intent 关键字段**：

| 字段 | 值 / 说明 |
|------|-----------|
| Action | `Telephony.Sms.Intents.WAP_PUSH_DELIVER_ACTION`（= `"android.provider.Telephony.WAP_PUSH_DELIVER"`） |
| Type | `application/vnd.wap.mms-message`（MMS WAP Push）或其他 MIME 类型 |
| `transactionId` | WSP 事务 ID |
| `pduType` | PUSH 或 CONFIRMED_PUSH |
| `header` | WSP 头部原始字节 |
| `data` | 消息体字节（MMS Notification Ind 编码数据） |
| `address` | 发送方电话号码 |
| `messageId` | raw 表中的消息追踪 ID |

#### 4.3.2 定向发送到默认 MMS 应用

```java
UserHandle userHandle = TelephonyUtils.getSubscriptionUserHandle(mContext, subId);
if (userHandle == null) {
    userHandle = mUserManager.getMainUser();
}
ComponentName componentName = SmsApplication.getDefaultMmsApplicationAsUser(mContext,
        true, userHandle);

if (componentName != null) {
    // 仅将 MMS 消息投递到此接收器
    intent.setComponent(componentName);
    if (DBG) Rlog.v(TAG, "Delivering MMS to: " + componentName.getPackageName()
            + " " + componentName.getClassName());
    // 临时白名单，确保目标应用不受后台执行限制
    long duration = mPowerWhitelistManager.whitelistAppTemporarilyForEvent(
            componentName.getPackageName(), PowerWhitelistManager.EVENT_MMS,
            REASON_EVENT_MMS, "mms-app");
    BroadcastOptions bopts = BroadcastOptions.makeBasic();
    bopts.setTemporaryAppAllowlist(duration,
            TEMPORARY_ALLOWLIST_TYPE_FOREGROUND_SERVICE_ALLOWED,
            REASON_EVENT_MMS, "");
    options = bopts.toBundle();
}
```

**关键设计**：

1. **`setComponent()`** —— 将广播定向到特定应用组件，确保只有默认 MMS 应用能收到第一阶段广播。
2. **`PowerWhitelistManager`** —— 通过临时白名单机制，允许默认 MMS 应用在收到广播后启动前台服务、访问网络等操作，即使应用当前处于后台状态。
3. **UserHandle 绑定** —— 广播仅发送到与 SIM 卡关联的用户空间。

#### 4.3.3 dispatchIntent() 调用

```java
handler.dispatchIntent(intent, getPermissionForType(result.mimeType),
        getAppOpsStringPermissionForIntent(result.mimeType), options, receiver,
        userHandle, subId);
return Activity.RESULT_OK;
```

`InboundSmsHandler.dispatchIntent()` 方法内部执行以下操作：

```java
public void dispatchIntent(Intent intent, String permission, String appOp,
        Bundle opts, SmsBroadcastReceiver resultReceiver, UserHandle user, int subId) {
    intent.addFlags(Intent.FLAG_RECEIVER_NO_ABORT);    // 防止接收器异常导致广播链中断
    if (Intents.WAP_PUSH_DELIVER_ACTION.equals(action)
            || Intents.WAP_PUSH_RECEIVED_ACTION.equals(action)) {
        intent.addFlags(Intent.FLAG_RECEIVER_FOREGROUND);  // 高优先级前台广播
    }
    SubscriptionManager.putPhoneIdAndSubIdExtra(intent, mPhone.getPhoneId());
    dispatchSmsToUsers(intent, permission, appOp, opts, resultReceiver, user, textLinks);
}
```

最终通过 `sendOrderedBroadcast()` 发送 **有序广播**（Ordered Broadcast），`SmsBroadcastReceiver` 作为结果接收器注册在广播链中。

### 4.4 权限控制

WAP Push 广播的权限控制分为 **Android Manifest 权限** 和 **AppOps 运行时权限** 两层。具体权限由 MIME 类型决定：

```java
public static String getPermissionForType(String mimeType) {
    if (WspTypeDecoder.CONTENT_TYPE_B_MMS.equals(mimeType)) {
        return android.Manifest.permission.RECEIVE_MMS;
    } else {
        return android.Manifest.permission.RECEIVE_WAP_PUSH;
    }
}

public static String getAppOpsStringPermissionForIntent(String mimeType) {
    if (WspTypeDecoder.CONTENT_TYPE_B_MMS.equals(mimeType)) {
        return AppOpsManager.OPSTR_RECEIVE_MMS;
    } else {
        return AppOpsManager.OPSTR_RECEIVE_WAP_PUSH;
    }
}
```

**权限矩阵**：

| MIME 类型 | Manifest 权限 | AppOps 权限 | 适用场景 |
|-----------|---------------|-------------|----------|
| `application/vnd.wap.mms-message` | `android.permission.RECEIVE_MMS` | `OPSTR_RECEIVE_MMS` | MMS 通知（第一阶段 WAP_PUSH_DELIVER） |
| 其他 WAP Push 类型 | `android.permission.RECEIVE_WAP_PUSH` | `OPSTR_RECEIVE_WAP_PUSH` | 通用 WAP Push（如 SI、SL、CO 等） |

**两阶段广播的权限一致性**：

> 在 `SmsBroadcastReceiver.onReceive()` 中，第二阶段 `WAP_PUSH_RECEIVED_ACTION` 广播的权限也通过 `WapPushOverSms.getPermissionForType(mimeType)` 和 `getAppOpsStringPermissionForIntent(mimeType)` 获取，确保两阶段使用**完全相同的权限模型**。

**权限控制总结**：

| 控制层级 | 机制 | 说明 |
|----------|------|------|
| 第一层 | Manifest 权限（`RECEIVE_MMS` / `RECEIVE_WAP_PUSH`） | 仅持有声明权限的应用可接收广播 |
| 第二层 | AppOps 运行时检查（`OP_RECEIVE_MMS` / `OP_RECEIVE_WAP_PUSH`） | 用户可在设置中单独禁用某应用的接收权限 |
| 第三层 | `setComponent()`（第一阶段） | 进一步限制只有默认 MMS 应用可接收 |
| 第四层 | `PowerWhitelistManager` 临时白名单 | 允许目标应用在后台执行必要操作 |

---

## 第5章 二阶段 WAP Push 广播

Android Telephony 框架对 WAP Push 消息采用 **二阶段广播机制**（Two-Phase Broadcast），其设计与 SMS 消息的处理模式一致。第一阶段通过有序广播（Ordered Broadcast）优先投递给默认 MMS 应用；第二阶段转为普通广播通知所有已注册的接收器。

### 5.1 第一阶段 WAP_PUSH_DELIVER_ACTION 有序广播

**触发点**：`WapPushOverSms.dispatchWapPdu()` 调用 `handler.dispatchIntent()`，Intent Action 为 `WAP_PUSH_DELIVER_ACTION`。

**关键特征**：

```java
// WapPushOverSms.dispatchWapPdu() 中：
Intent intent = new Intent(Intents.WAP_PUSH_DELIVER_ACTION);
intent.setType("application/vnd.wap.mms-message");
intent.setComponent(componentName);    // 定向到默认 MMS 应用

// InboundSmsHandler.dispatchIntent() 中：
intent.addFlags(Intent.FLAG_RECEIVER_NO_ABORT);     // 不因接收器异常中断
intent.addFlags(Intent.FLAG_RECEIVER_FOREGROUND);   // 前台高优先级

// sendBroadcast() 中：
mContext.sendOrderedBroadcast(intent, Activity.RESULT_OK,
        android.Manifest.permission.RECEIVE_MMS,
        AppOpsManager.OPSTR_RECEIVE_MMS,
        resultReceiver, getHandler(), ...);
```

| 属性 | 值 | 说明 |
|------|-----|------|
| 广播类型 | 有序广播（Ordered Broadcast） | 接收器按优先级依次处理 |
| Action | `WAP_PUSH_DELIVER_ACTION` | "android.provider.Telephony.WAP_PUSH_DELIVER" |
| Component | `setComponent(默认MMS应用)` | 仅定向到默认 MMS 应用组件 |
| 权限 | `RECEIVE_MMS` + `OPSTR_RECEIVE_MMS` | 声明权限 + AppOps 双重控制 |
| 结果接收器 | `SmsBroadcastReceiver` | 广播完成后回调 `onReceive()` |
| 初始结果码 | `Activity.RESULT_OK` | 有序广播的默认初始 resultCode |

**第一阶段调用链**：

```
WapPushOverSms.dispatchWapPdu()
  └── InboundSmsHandler.dispatchIntent()
        └── dispatchSmsToUsers()
              └── sendBroadcast()
                    └── sendOrderedBroadcast(intent, RESULT_OK,
                          RECEIVE_MMS, OPSTR_RECEIVE_MMS,
                          smsBroadcastReceiver, handler, ...)
                          │
                          ▼
                    默认 MMS 应用接收广播
                          │
                          ▼
                    SmsBroadcastReceiver.onReceive()  ← 广播完成回调
```

### 5.2 SmsBroadcastReceiver.onReceive() 处理流程

`SmsBroadcastReceiver` 是 `InboundSmsHandler` 的内部类，它作为有序广播的 `BroadcastReceiver`，在广播完成后触发回调，驱动状态机从 `WaitingState` 转换。

**回调入口**（`InboundSmsHandler.java` 约2158行）：

```java
@Override
public void onReceive(Context context, Intent intent) {
    if (intent == null) {
        logeWithLocalLog("onReceive: received null intent, faking " + mWaitingForIntent,
                mInboundSmsTracker.getMessageId());
        return;
    }
    handleAction(intent, true);
}
```

**handleAction() 核心逻辑**（约2168行）：

```java
private synchronized void handleAction(@NonNull Intent intent, boolean onReceive) {
    String action = intent.getAction();
    // 校验：确保收到的广播 Action 与预期一致
    if (mWaitingForIntent == null || !mWaitingForIntent.getAction().equals(action)) {
        logeWithLocalLog("handleAction: Received " + action + " when expecting "
                + (mWaitingForIntent == null ? "none" : mWaitingForIntent.getAction()),
                mInboundSmsTracker.getMessageId());
        return;
    }

    if (onReceive) {
        // 记录有序广播完成耗时
        int durationMillis = (int) (System.currentTimeMillis() - mBroadcastTimeMillis);
        if (durationMillis >= 5000) {
            loge("Slow ordered broadcast completion time for " + action
                    + ": " + durationMillis + " ms");
        }
    }

    int subId = intent.getIntExtra(SubscriptionManager.EXTRA_SUBSCRIPTION_INDEX,
            SubscriptionManager.INVALID_SUBSCRIPTION_ID);

    if (action.equals(Intents.WAP_PUSH_DELIVER_ACTION)) {
        // === WAP Push 第一阶段完成 → 触发第二阶段 ===
        // ... 见 5.3 节
    } else if (action.equals(Intents.SMS_DELIVER_ACTION)) {
        // === SMS 第一阶段完成 → 触发第二阶段 ===
        // ...
    } else {
        // === 第二阶段（WAP_PUSH_RECEIVED_ACTION）完成 → 清理 raw 表 ===
        // ... 见 5.5 节
    }
}
```

**resultCode 判断**：

在 `onReceive` 回调中，`getResultCode()` 可获取有序广播中接收器设置的结果码。对于 `WAP_PUSH_DELIVER_ACTION`，框架当前的实现并未根据 resultCode 做条件分支（即无论默认 MMS 应用返回什么结果码，都会继续发送第二阶段广播）。这与 SMS 路径的行为一致——框架采用"投递后不干预"的策略。

> **注**：对于非 WAP Push 的第二阶段广播（如 `WAP_PUSH_RECEIVED_ACTION`），`handleAction()` 的 `else` 分支会检查 `resultCode`，但最终无论结果如何都会执行 raw 表清理（`deleteFromRawTable`）。

### 5.3 第二阶段 WAP_PUSH_RECEIVED_ACTION 转换

第一阶段有序广播完成后，`SmsBroadcastReceiver.onReceive()` 自动触发第二阶段广播的发送：

```java
} else if (action.equals(Intents.WAP_PUSH_DELIVER_ACTION)) {
    // 第一阶段完成，转换为第二阶段通知广播

    // 1. 变更 Action
    intent.setAction(Intents.WAP_PUSH_RECEIVED_ACTION);

    // 2. 取消定向，所有应用可接收
    intent.setComponent(null);

    // 3. PowerWhitelistManager 临时白名单（对 telephony 自身）
    long duration = 0;
    if (mPowerWhitelistManager != null) {
        duration = mPowerWhitelistManager.whitelistAppTemporarilyForEvent(
                mContext.getPackageName(),
                PowerWhitelistManager.EVENT_MMS,
                REASON_EVENT_MMS,
                "mms-broadcast");
    }
    BroadcastOptions bopts = BroadcastOptions.makeBasic();
    bopts.setTemporaryAppAllowlist(duration,
            TEMPORARY_ALLOWLIST_TYPE_FOREGROUND_SERVICE_ALLOWED,
            REASON_EVENT_MMS, "");
    Bundle options = bopts.toBundle();

    // 4. 获取原始 MIME 类型
    String mimeType = intent.getType();

    // 5. 设置等待 Intent（用于追踪第二阶段广播完成）
    setWaitingForIntent(intent);

    // 6. 派发第二阶段广播
    dispatchIntent(intent, WapPushOverSms.getPermissionForType(mimeType),
            WapPushOverSms.getAppOpsStringPermissionForIntent(mimeType), options,
            this, mUserManager.getMainUser(), subId);
}
```

**两阶段对比**：

| 属性 | 第一阶段 | 第二阶段 |
|------|----------|----------|
| Action | `WAP_PUSH_DELIVER_ACTION` | `WAP_PUSH_RECEIVED_ACTION` |
| 广播类型 | 有序广播（Ordered Broadcast） | 有序广播（Ordered Broadcast） |
| 目标 | `setComponent(默认MMS应用)` — 定向 | `setComponent(null)` — 所有注册接收器 |
| 权限 | `RECEIVE_MMS` + `OPSTR_RECEIVE_MMS` | `RECEIVE_MMS` + `OPSTR_RECEIVE_MMS`（相同） |
| UserHandle | SIM 卡关联用户 | `mUserManager.getMainUser()`（主用户） |
| Intent Extra | 包含完整 header/data/address | 同第一阶段（同一 Intent 对象修改后复用） |
| 用途 | 默认 MMS 应用执行下载 | 通知其他应用（如短信备份、安全软件等） |

> **注**：代码注释 `// Only the primary user will receive notification of incoming mms.` 表明第二阶段仅发送给主用户。

**两阶段状态流转**：

```
                    ┌─────────────────────────────────┐
                    │     InboundSmsHandler            │
                    │                                 │
  dispatchWapPdu()  │  IdleState → DeliveringState    │
  ──────────────►   │      │                          │
                    │      ▼                          │
                    │  WaitingState                    │
                    │      │                          │
                    │      ├── [第一阶段有序广播]       │
                    │      │   WAP_PUSH_DELIVER_ACTION │
                    │      │   → setComponent(MMS App) │
                    │      │                          │
                    │      ▼                          │
                    │  SmsBroadcastReceiver.onReceive() │
                    │      │                          │
                    │      ├── [第二阶段有序广播]       │
                    │      │   WAP_PUSH_RECEIVED_ACTION│
                    │      │   → setComponent(null)    │
                    │      │                          │
                    │      ▼                          │
                    │  SmsBroadcastReceiver.onReceive()│
                    │      │                          │
                    │      ├── deleteFromRawTable()   │
                    │      └── EVENT_BROADCAST_COMPLETE│
                    │      │                          │
                    │      ▼                          │
                    │  IdleState                       │
                    └─────────────────────────────────┘
```

### 5.4 两阶段设计目的

Android Telephony 框架采用二阶段广播的核心目标是**优先保证默认 MMS 应用的消息处理**，同时兼顾其他应用的接收需求。

**设计考量**：

| 设计维度 | 说明 |
|----------|------|
| **优先级保证** | 第一阶段通过 `setComponent()` 定向发送到默认 MMS 应用，确保其最先收到消息并可触发 MMS 自动下载，不受其他应用干扰 |
| **功能分离** | 第一阶段（DELIVER）面向默认应用的处理型广播；第二阶段（RECEIVED）面向所有应用的**通知型**广播 |
| **容错性** | 即使第一阶段广播被默认应用取消（`abortBroadcast()`），第二阶段仍会发送，确保消息不丢失 |
| **兼容性** | 允许非默认的 MMS 应用、短信备份工具、安全扫描应用等通过第二阶段广播感知到 MMS 消息 |
| **用户体验** | 默认 MMS 应用收到第一阶段广播后可立即开始自动下载（若启用），第二阶段广播仅用于展示通知或执行辅助操作 |

**与 SMS 二阶段机制的对比**：

```
SMS 路径：
  SMS_DELIVER_ACTION (有序, 定向) → SMS_RECEIVED_ACTION (有序, 广播)

WAP Push 路径：
  WAP_PUSH_DELIVER_ACTION (有序, 定向) → WAP_PUSH_RECEIVED_ACTION (有序, 广播)
```

两条路径的架构完全一致，均通过 `SmsBroadcastReceiver.onReceive()` 实现阶段转换，通过 `setComponent(null)` 取消定向。

### 5.5 raw 表清理与状态机恢复（EVENT_BROADCAST_COMPLETE）

第二阶段 `WAP_PUSH_RECEIVED_ACTION` 有序广播完成后，`SmsBroadcastReceiver.onReceive()` 的 `else` 分支执行最终的清理和状态机恢复：

```java
} else {
    // 第二阶段广播（WAP_PUSH_RECEIVED_ACTION）完成后的处理

    // 1. 非 SMS_RECEIVED / WAP_PUSH_RECEIVED / DATA_SMS_RECEIVED 的 Action 记录错误日志
    if (!Intents.DATA_SMS_RECEIVED_ACTION.equals(action)
            && !Intents.SMS_RECEIVED_ACTION.equals(action)
            && !Intents.WAP_PUSH_RECEIVED_ACTION.equals(action)) {
        loge("unexpected BroadcastReceiver action: " + action);
    }

    // 2. 检查有序广播结果码
    if (onReceive) {
        int rc = getResultCode();
        if ((rc != Activity.RESULT_OK) && (rc != Intents.RESULT_SMS_HANDLED)) {
            loge("a broadcast receiver set the result code to " + rc
                    + ", deleting from raw table anyway!");
        } else if (DBG) {
            log("successful broadcast, deleting from raw table.");
        }
    }

    // 3. 从 raw 表中删除对应记录
    deleteFromRawTable(mDeleteWhere, mDeleteWhereArgs, MARK_DELETED);

    // 4. 清除等待状态
    mWaitingForIntent = null;

    // 5. 移除超时消息（不再需要超时保护）
    removeMessages(EVENT_RECEIVER_TIMEOUT);

    // 6. 发送 EVENT_BROADCAST_COMPLETE 到状态机
    sendMessage(EVENT_BROADCAST_COMPLETE);
}
```

**raw 表清理细节**：

| 步骤 | 操作 | 说明 |
|------|------|------|
| `deleteFromRawTable()` | 删除 `raw` 表中对应记录 | 将 PDU 数据从持久化存储中移除 |
| `MARK_DELETED` 标记 | 更新为删除状态 | `deleteFromRawTable()` 内部会将记录标记为已删除而非物理删除 |
| `mWaitingForIntent = null` | 清除等待引用 | 表示不再有正在等待的广播 |
| `removeMessages(EVENT_RECEIVER_TIMEOUT)` | 取消超时定时器 | 广播已完成，无需超时回退机制 |

**EVENT_BROADCAST_COMPLETE 状态机转换**：

`EVENT_BROADCAST_COMPLETE` 消息发送到 `InboundSmsHandler` 状态机后，触发 `WaitingState` 向 `IdleState` 的转换：

```
WaitingState
  └── processMessage(EVENT_BROADCAST_COMPLETE)
        ├── 释放 WakeLock（在 IdleState.enter() 中执行）
        └── transitionTo(IdleState)
              └── 状态机回到空闲，可处理下一条消息
```

**超时保护机制**：

若第二阶段广播因异常原因未能触发 `onReceive()` 回调，`EVENT_RECEIVER_TIMEOUT` 消息将在超时后触发 `fakeNextAction()` 方法：

```java
public synchronized void fakeNextAction() {
    Intent intent = mWaitingForIntent;
    if (intent != null) {
        logeWithLocalLog("fakeNextAction: " + intent.getAction(),
                mInboundSmsTracker.getMessageId());
        handleAction(intent, false);   // onReceive = false
    }
}
```

`fakeNextAction()` 会调用 `handleAction(intent, false)`，其中 `onReceive=false` 表示这不是真实的广播回调，但清理逻辑（raw 表删除、状态机恢复）仍会正常执行，确保状态机不会卡死在 `WaitingState`。

**完整生命周期**：

```
PDU 到达
  │
  ├── [GSM/WCDMA/LTE RIL] RIL 收到 SMS-DELIVER
  │
  ├── [InboundSmsHandler] addTrackerToRawTable() → raw 表持久化
  │
  ├── [InboundSmsHandler] DeliveringState → processMessagePart()
  │     └── isWapPush == true → WapPushOverSms.dispatchWapPdu()
  │
  ├── [WapPushOverSms] decodeWapPdu() → DecodedResult
  │
  ├── [WapPushOverSms] 构造 WAP_PUSH_DELIVER_ACTION Intent
  │     └── setComponent(默认MMS应用)
  │
  ├── [InboundSmsHandler] sendOrderedBroadcast() → 第一阶段
  │     └── WaitingState（等待广播完成）
  │
  ├── [默认MMS应用] 收到广播，触发 MMS 下载
  │
  ├── [SmsBroadcastReceiver.onReceive()] 第一阶段完成
  │     └── 转换为 WAP_PUSH_RECEIVED_ACTION + setComponent(null)
  │
  ├── [InboundSmsHandler] sendOrderedBroadcast() → 第二阶段
  │
  ├── [其他应用] 收到 WAP_PUSH_RECEIVED_ACTION 通知
  │
  ├── [SmsBroadcastReceiver.onReceive()] 第二阶段完成
  │     ├── deleteFromRawTable()（清理 raw 表）
  │     └── EVENT_BROADCAST_COMPLETE
  │
  └── [InboundSmsHandler] IdleState（释放 WakeLock，回到空闲）
```

> **总结**：二阶段广播机制是 Android Telephony 处理所有入站短信/WAP Push 的统一架构。对 WAP Push 而言，第一阶段确保默认 MMS 应用能在第一时间收到 MMS 通知并启动下载流程；第二阶段通知其他关注 MMS 消息的应用。`SmsBroadcastReceiver` 作为衔接两阶段的桥梁，在每阶段完成后驱动状态机转换，并在最终阶段执行 raw 表清理和 WakeLock 释放，确保系统资源正确回收。

---

## 第6章 Messaging 应用接收 WAP Push

当运营商 MMSC 向用户发送 MMS 消息时，不会直接推送完整的彩信内容，而是先发送一条 WAP Push 通知（m-notification-ind），告知终端有一条彩信待下载。本章详细分析 AOSP Messaging 应用如何接收和处理这条 WAP Push 消息。

### 6.1 MmsWapPushDeliverReceiver：有序广播接收

`MmsWapPushDeliverReceiver` 用于接收 Android 系统发送的 **有序广播（Ordered Broadcast）**，对应的 Action 为 `WAP_PUSH_DELIVER_ACTION`。该广播是在 Android 4.4（KitKat）及以上版本中由 Telephony 框架发出的。

```java
// MmsWapPushDeliverReceiver.java
public class MmsWapPushDeliverReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(final Context context, final Intent intent) {
        if (Telephony.Sms.Intents.WAP_PUSH_DELIVER_ACTION.equals(intent.getAction())
                && ContentType.MMS_MESSAGE.equals(intent.getType())) {
            int subId = PhoneUtils.getDefault().getEffectiveIncomingSubIdFromSystem(
                    intent, MmsWapPushReceiver.EXTRA_SUBSCRIPTION);
            byte[] data = intent.getByteArrayExtra(MmsWapPushReceiver.EXTRA_DATA);
            MmsWapPushReceiver.mmsReceived(subId, data);
        }
    }
}
```

处理流程：

| 步骤 | 操作 | 说明 |
|------|------|------|
| 1 | 验证 Action | 检查 `intent.getAction()` 是否为 `WAP_PUSH_DELIVER_ACTION` |
| 2 | 验证 Type | 检查 `intent.getType()` 是否为 `application/vnd.wap.mms-message` |
| 3 | 提取 subId | 通过 `getEffectiveIncomingSubIdFromSystem()` 获取订阅 ID，负值转为 -1 |
| 4 | 提取 data | 从 Intent 中取出 `byte[]` 形式的 WAP Push PDU 数据 |
| 5 | 委托处理 | 调用 `MmsWapPushReceiver.mmsReceived(subId, data)` |

### 6.2 MmsWapPushReceiver：非有序广播接收

`MmsWapPushReceiver` 用于接收 **非有序广播（Non-Ordered Broadcast）**，对应的 Action 为 `WAP_PUSH_RECEIVED_ACTION`。

```java
// MmsWapPushReceiver.java
public class MmsWapPushReceiver extends BroadcastReceiver {
    static final String EXTRA_SUBSCRIPTION = "subscription";
    static final String EXTRA_DATA = "data";

    @Override
    public void onReceive(final Context context, final Intent intent) {
        if (Telephony.Sms.Intents.WAP_PUSH_RECEIVED_ACTION.equals(intent.getAction())
                && ContentType.MMS_MESSAGE.equals(intent.getType())) {
            if (PhoneUtils.getDefault().isSmsEnabled()) {
                final int subId = PhoneUtils.getDefault().getEffectiveIncomingSubIdFromSystem(
                        intent, MmsWapPushReceiver.EXTRA_SUBSCRIPTION);
                final byte[] data = intent.getByteArrayExtra(EXTRA_DATA);
                mmsReceived(subId, data);
            }
        }
    }
}
```

两个 Receiver 对比：

| 对比维度 | MmsWapPushDeliverReceiver | MmsWapPushReceiver |
|----------|--------------------------|-------------------|
| 广播 Action | `WAP_PUSH_DELIVER_ACTION` | `WAP_PUSH_RECEIVED_ACTION` |
| 广播类型 | 有序广播（Ordered） | 非有序广播（Non-Ordered） |
| 适用平台 | KitKat 及以上 | KitKat 之前（兼容） |
| SMS 启用检查 | 在 `mmsReceived()` 中检查 | 在 `onReceive()` 中先检查，再调用 `mmsReceived()` |

### 6.3 mmsReceived() 静态方法

`mmsReceived()` 是两个广播接收器的统一处理入口：

```java
// MmsWapPushReceiver.java
static void mmsReceived(final int subId, final byte[] data) {
    if (!PhoneUtils.getDefault().isSmsEnabled()) {
        return;
    }
    final ReceiveMmsMessageAction action = new ReceiveMmsMessageAction(subId, data);
    action.start();
}
```

该方法仅做两件事：一是通过 `isSmsEnabled()` 判断当前用户是否启用了短信功能；二是将 `subId` 和原始 WAP Push PDU 数据封装为 `ReceiveMmsMessageAction`，调用 `start()` 提交到异步的 ActionService 中执行。

### 6.4 ReceiveMmsMessageAction 异步 Action 处理机制

`ReceiveMmsMessageAction` 继承自 `Action` 类并实现 `Parcelable` 接口，是 Messaging 应用 ActionService 架构的核心组件之一。

```java
// ReceiveMmsMessageAction.java
private static final String KEY_SUB_ID = "sub_id";
private static final String KEY_PUSH_DATA = "push_data";
private static final String KEY_TRANSACTION_ID = "transaction_id";
private static final String KEY_CONTENT_LOCATION = "content_location";

public ReceiveMmsMessageAction(final int subId, final byte[] pushData) {
    actionParameters.putInt(KEY_SUB_ID, subId);
    actionParameters.putByteArray(KEY_PUSH_DATA, pushData);
}
```

| 参数键 | 类型 | 用途 |
|--------|------|------|
| `KEY_SUB_ID` | int | SIM 卡订阅 ID |
| `KEY_PUSH_DATA` | byte[] | 原始 WAP Push PDU 数据 |
| `KEY_TRANSACTION_ID` | String | MMS 事务 ID（后续用于 NotifyRespInd） |
| `KEY_CONTENT_LOCATION` | String | MMSC 下载 URL（后续用于 NotifyRespInd） |

`executeAction()` 总体流程：

```
executeAction()
    |
    ├── 1. 获取参数（subId, pushData）
    ├── 2. 获取/创建 Self 参与者
    ├── 3. 通知 SyncManager 新消息时间戳
    ├── 4. 调用 processReceivedPdu() 解析 PDU
    ├── 5. 判断 blocked 状态
    ├── 6. 判断 autoDownload（调用 allowMmsAutoRetrieve）
    ├── 7. 获取/创建会话 ID
    ├── 8. 数据库事务写入
    ├── 9. 非 autoDownload 场景处理
    ├── 10. 调度 ProcessPendingMessagesAction
    └── 返回 message
```

### 6.5 processReceivedPdu() 解析 m-notification-ind PDU

`MmsUtils.processReceivedPdu()` 方法负责将原始的 WAP Push 字节流解析为结构化的 MMS 通知消息对象：

```java
// MmsUtils.java (line 2193)
public static DatabaseMessages.MmsMessage processReceivedPdu(final Context context,
        final byte[] pushData, final int subId, final String subPhoneNumber) {

    final PduParser parser = new PduParser(pushData,
            MmsConfig.get(subId).getSupportMmsContentDisposition());
    final GenericPdu pdu = parser.parse();

    if (null == pdu) {
        LogUtil.e(TAG, "Invalid PUSH data");
        return null;
    }

    final PduPersister p = PduPersister.getPduPersister(context);
    final int type = pdu.getMessageType();

    Uri messageUri = null;
    switch (type) {
        case PduHeaders.MESSAGE_TYPE_DELIVERY_IND:
        case PduHeaders.MESSAGE_TYPE_READ_ORIG_IND:
            LogUtil.w(TAG, "Received unsupported WAP Push, type=" + type);
            break;
        case PduHeaders.MESSAGE_TYPE_NOTIFICATION_IND: {
            final NotificationInd nInd = (NotificationInd) pdu;

            // TransId 处理：如果 contentLocation 末尾是 '='，拼接 transactionId
            if (MmsConfig.get(subId).getTransIdEnabled()) {
                final byte[] contentLocationTemp = nInd.getContentLocation();
                if ('=' == contentLocationTemp[contentLocationTemp.length - 1]) {
                    final byte[] transactionIdTemp = nInd.getTransactionId();
                    final byte[] contentLocationWithId =
                            new byte[contentLocationTemp.length + transactionIdTemp.length];
                    System.arraycopy(contentLocationTemp, 0, contentLocationWithId,
                            0, contentLocationTemp.length);
                    System.arraycopy(transactionIdTemp, 0, contentLocationWithId,
                            contentLocationTemp.length, transactionIdTemp.length);
                    nInd.setContentLocation(contentLocationWithId);
                }
            }

            // 重复通知检查
            final String[] dups = getDupNotifications(context, nInd);
            if (dups == null) {
                // 持久化到 telephony MMS Inbox
                Uri inboxUri = p.persist(pdu, Mms.Inbox.CONTENT_URI, subId,
                        subPhoneNumber, null);
                messageUri = ContentUris.withAppendedId(Mms.CONTENT_URI,
                        ContentUris.parseId(inboxUri));
            }
            break;
        }
        default:
            LogUtil.e(TAG, "Received unrecognized WAP Push, type=" + type);
    }

    DatabaseMessages.MmsMessage mms = null;
    if (messageUri != null) {
        mms = MmsUtils.loadMms(messageUri);
    }
    return mms;
}
```

解析流程：

```
processReceivedPdu(context, pushData, subId, subPhoneNumber)
    |
    ├── PduParser.parse() ─── 将原始字节解析为 GenericPdu 对象
    |
    ├── 判断 pdu 类型
    |   ├── DELIVERY_IND / READ_ORIG_IND ── 不支持，跳过
    |   ├── NOTIFICATION_IND ─── MMS 下载通知（核心处理路径）
    |   └── 其他类型 ─── 记录错误日志
    |
    └── 对于 NOTIFICATION_IND：
        ├── 1. TransId 拼接处理
        ├── 2. 重复通知检查（getDupNotifications）
        ├── 3. PduPersister.persist() ── 持久化到 telephony DB
        ├── 4. 加载 MmsMessage 对象（loadMms）
        └── 5. 返回 MmsMessage（包含 mContentLocation, mTransactionId 等）
```

m-notification-ind PDU 中携带的核心字段：

| 字段 | 类型 | 说明 | 后续用途 |
|------|------|------|---------|
| `contentLocation` | byte[] | MMSC 上的消息下载 URL | HTTP GET 下载完整 MMS |
| `transactionId` | byte[] | 事务标识符 | NotifyRespInd 响应中的事务关联 |
| `messageSize` | long | 消息大小（字节） | UI 展示、空间检查 |
| `expiry` | long | 过期时间（秒） | 下载窗口判断 |
| `from` | EncodedStringValue | 发送方地址 | 参与者识别、会话匹配 |

当运营商配置了 `transIdEnabled` 时，如果 `contentLocation` 以 `'='` 结尾（表示 URL 中包含需要填充的查询参数），系统会将 `transactionId` 直接拼接到 `contentLocation` 末尾，形成完整的下载 URL。例如：

```
contentLocation: "http://mmsc.operator.com/mms?tid="
transactionId:   "abc123"
拼接结果:         "http://mmsc.operator.com/mms?tid=abc123"
```

---

## 第7章 自动下载判断与触发

当 WAP Push 消息被成功解析后，Messaging 应用需要决定是否立即自动下载 MMS 完整内容。本章详细分析自动下载的判断逻辑、数据库记录创建、以及下载任务的调度与状态转换机制。

### 7.1 allowMmsAutoRetrieve() 判断逻辑

`MmsUtils.allowMmsAutoRetrieve()` 是自动下载决策的核心判断方法：

```java
// MmsUtils.java (line 1117)
public static boolean allowMmsAutoRetrieve(final int subId) {
    final Context context = Factory.get().getApplicationContext();
    final Resources resources = context.getResources();
    final BuglePrefs prefs = BuglePrefs.getSubscriptionPrefs(subId);
    final boolean autoRetrieve = prefs.getBoolean(
            resources.getString(R.string.auto_retrieve_mms_pref_key),
            resources.getBoolean(R.bool.auto_retrieve_mms_pref_default));
    if (autoRetrieve) {
        final boolean autoRetrieveInRoaming = prefs.getBoolean(
                resources.getString(R.string.auto_retrieve_mms_when_roaming_pref_key),
                resources.getBoolean(R.bool.auto_retrieve_mms_when_roaming_pref_default));
        final PhoneUtils phoneUtils = PhoneUtils.get(subId);
        if ((autoRetrieveInRoaming && phoneUtils.isDataRoamingEnabled())
                || !phoneUtils.isRoaming()) {
            return true;
        }
    }
    return false;
}
```

判断决策流程：

```
allowMmsAutoRetrieve(subId)
    |
    ├── 读取 auto_retrieve_mms_pref_key ─── 总开关是否开启？
    |   ├── false ── 直接返回 false（用户关闭了自动下载）
    |   └── true
    |       |
    |       ├── 读取 auto_retrieve_mms_when_roaming_pref_key
    |       |   └── 漫游时是否允许自动下载？
    |       |
    |       ├── 判断当前是否处于漫游
    |       |   ├── 非漫游（!isRoaming()） ── 返回 true
    |       |   └── 漫游中
    |       |       ├── 漫游自动下载开启 && 数据漫游已启用 ── 返回 true
    |       |       └── 否则 ── 返回 false
    |       |
    └── 返回 false（兜底）
```

决策矩阵：

| 总开关 (autoRetrieve) | 是否漫游 | 漫游自动下载 | 数据漫游启用 | 最终结果 |
|----------------------|---------|------------|------------|---------|
| false | 任意 | 任意 | 任意 | **false** |
| true | 否 | 任意 | 任意 | **true** |
| true | 是 | true | true | **true** |
| true | 是 | true | false | **false** |
| true | 是 | false | 任意 | **false** |

关键配置项：

| 配置键 | 说明 | 类型 |
|--------|------|------|
| `auto_retrieve_mms_pref_key` | 自动下载总开关 | 用户偏好设置 |
| `auto_retrieve_mms_pref_default` | 总开关默认值 | 布尔资源 |
| `auto_retrieve_mms_when_roaming_pref_key` | 漫游时自动下载开关 | 用户偏好设置 |
| `auto_retrieve_mms_when_roaming_pref_default` | 漫游开关默认值 | 布尔资源 |

漫游场景下不仅需要用户开启"漫游时自动下载"偏好设置，还需要设备层面启用"数据漫游"（`isDataRoamingEnabled()`），两者缺一不可，防止用户在不知情的情况下产生漫游数据流量费用。

### 7.2 消息状态设置

根据自动下载判断结果，消息被赋予不同的初始状态。在 `ReceiveMmsMessageAction.executeAction()` 中：

```java
// ReceiveMmsMessageAction.java (line 114)
message = MmsUtils.createMmsMessage(mms, conversationId, participantId, selfId,
        (autoDownload ? MessageData.BUGLE_STATUS_INCOMING_RETRYING_AUTO_DOWNLOAD :
            MessageData.BUGLE_STATUS_INCOMING_YET_TO_MANUAL_DOWNLOAD));
```

incoming 消息状态常量：

| 常量 | 值 | 含义 |
|------|---|------|
| `BUGLE_STATUS_INCOMING_COMPLETE` | 100 | 下载完成 |
| `BUGLE_STATUS_INCOMING_YET_TO_MANUAL_DOWNLOAD` | 101 | 等待用户手动下载 |
| `BUGLE_STATUS_INCOMING_RETRYING_MANUAL_DOWNLOAD` | 102 | 手动下载重试中 |
| `BUGLE_STATUS_INCOMING_MANUAL_DOWNLOADING` | 103 | 手动下载进行中 |
| `BUGLE_STATUS_INCOMING_RETRYING_AUTO_DOWNLOAD` | 104 | 自动下载重试中 |
| `BUGLE_STATUS_INCOMING_AUTO_DOWNLOADING` | 105 | 自动下载进行中 |
| `BUGLE_STATUS_INCOMING_DOWNLOAD_FAILED` | 106 | 下载失败 |
| `BUGLE_STATUS_INCOMING_EXPIRED_OR_NOT_AVAILABLE` | 107 | 已过期或不可用 |

`blocked` 状态具有最高优先级：

```java
// ReceiveMmsMessageAction.java (line 89-91)
final boolean blocked = BugleDatabaseOperations.isBlockedDestination(
        db, rawSender.getNormalizedDestination());
final boolean autoDownload = (!blocked && MmsUtils.allowMmsAutoRetrieve(subId));
```

即使 `allowMmsAutoRetrieve()` 返回 `true`，如果发送方被用户加入黑名单（blocked），`autoDownload` 也会被强制设为 `false`。

### 7.3 数据库记录创建

在完成 PDU 解析和状态判断后，`ReceiveMmsMessageAction` 在数据库事务中创建消息记录：

```java
// ReceiveMmsMessageAction.java (line 106-131)
db.beginTransaction();
try {
    final String participantId =
            BugleDatabaseOperations.getOrCreateParticipantInTransaction(db, rawSender);
    final String selfId =
            BugleDatabaseOperations.getOrCreateParticipantInTransaction(db, self);

    message = MmsUtils.createMmsMessage(mms, conversationId, participantId, selfId,
            (autoDownload ? MessageData.BUGLE_STATUS_INCOMING_RETRYING_AUTO_DOWNLOAD :
                MessageData.BUGLE_STATUS_INCOMING_YET_TO_MANUAL_DOWNLOAD));

    BugleDatabaseOperations.insertNewMessageInTransaction(db, message);

    if (!autoDownload) {
        BugleDatabaseOperations.updateConversationMetadataInTransaction(db,
                conversationId, message.getMessageId(), message.getReceivedTimeStamp(),
                blocked, true /* shouldAutoSwitchSelfId */);
        final ParticipantData sender = ParticipantData.getFromId(db, participantId);
        BugleActionToasts.onMessageReceived(conversationId, sender, message);
    }
    db.setTransactionSuccessful();
} finally {
    db.endTransaction();
}
```

数据关联关系：

```
DatabaseMessages.MmsMessage
    |
    ├── mThreadId ────── 关联到 telephony 的 threads 表
    ├── mContentLocation ── MMSC 下载 URL
    ├── mTransactionId ──── MMS 事务 ID
    |
    └── 转换为 MessageData
        ├── messageId ──── 自增主键
        ├── conversationId ── 会话 ID
        ├── participantId ─── 发送方参与者 ID
        ├── selfId ────── 当前用户参与者 ID
        ├── status ────── 消息状态
        └── smsMessageUri ── telephony DB 中的消息 URI
```

### 7.4 非自动下载时的处理

当 `autoDownload` 为 `false` 时，Messaging 应用执行一系列后续操作：

```java
// ReceiveMmsMessageAction.java (line 119-146)
if (!autoDownload) {
    // 1. 更新会话元数据
    BugleDatabaseOperations.updateConversationMetadataInTransaction(db,
            conversationId, message.getMessageId(), message.getReceivedTimeStamp(),
            blocked, true);
    // 2. 显示 Toast
    final ParticipantData sender = ParticipantData.getFromId(db, participantId);
    BugleActionToasts.onMessageReceived(conversationId, sender, message);
}

// 事务外处理
if (!autoDownload) {
    // 3. 通知 UI 数据变化
    MessagingContentProvider.notifyMessagesChanged(message.getConversationId());
    MessagingContentProvider.notifyPartsChanged();
    // 4. 显示通知栏通知
    BugleNotifications.update(false, conversationId, BugleNotifications.UPDATE_ALL);
    // 5. 准备发送 NotifyRespInd DEFERRED
    actionParameters.putString(KEY_TRANSACTION_ID, mms.mTransactionId);
    actionParameters.putString(KEY_CONTENT_LOCATION, mms.mContentLocation);
    requestBackgroundWork();
}
```

| 步骤 | 操作 | 说明 |
|------|------|------|
| 1 | 更新会话元数据 | 将最新消息信息写入会话记录，更新 snippet 等显示信息 |
| 2 | 显示 Toast | 在 UI 上弹出"收到新消息"提示 |
| 3 | ContentProvider 通知 | 触发 UI 刷新 |
| 4 | 显示系统通知 | 通过 `BugleNotifications` 在通知栏显示新消息通知 |
| 5 | 发送 NotifyRespInd | 通过 `requestBackgroundWork()` 在后台发送 DEFERRED 响应 |

`doBackgroundWork()` 发送 DEFERRED 响应：

```java
// ReceiveMmsMessageAction.java (line 161-174)
@Override
protected Bundle doBackgroundWork() throws DataModelException {
    final Context context = Factory.get().getApplicationContext();
    final int subId = actionParameters.getInt(KEY_SUB_ID, ParticipantData.DEFAULT_SELF_SUB_ID);
    final String transactionId = actionParameters.getString(KEY_TRANSACTION_ID);
    final String contentLocation = actionParameters.getString(KEY_CONTENT_LOCATION);
    MmsUtils.sendNotifyResponseForMmsDownload(
            context, subId,
            MmsUtils.stringToBytes(transactionId, "UTF-8"),
            contentLocation,
            PduHeaders.STATUS_DEFERRED);
    return null;
}
```

### 7.5 ProcessPendingMessagesAction 扫描与调度

在 `ReceiveMmsMessageAction.executeAction()` 的最后，总是调用调度方法：

```java
// ReceiveMmsMessageAction.java (line 155)
ProcessPendingMessagesAction.scheduleProcessPendingMessagesAction(false, this);
```

`ProcessPendingMessagesAction` 的 `findNextMessageToDownload()` 扫描逻辑：

```java
// ProcessPendingMessagesAction.java (line 405)
private static String findNextMessageToDownload(final DatabaseWrapper db,
        final long now, final String selfId) {
    String toDownloadMessageId = null;
    Cursor cursor = null;
    int downloadingCnt = 0;
    db.beginTransaction();
    try {
        // 1. 查询当前正在下载的消息数量
        downloadingCnt = (int) db.queryNumEntries(DatabaseHelper.MESSAGES_TABLE,
                DatabaseHelper.MessageColumns.STATUS + " IN (?, ?) AND "
                + DatabaseHelper.MessageColumns.SELF_PARTICIPANT_ID + " =?",
                new String[] {
                    Integer.toString(MessageData.BUGLE_STATUS_INCOMING_AUTO_DOWNLOADING),
                    Integer.toString(MessageData.BUGLE_STATUS_INCOMING_MANUAL_DOWNLOADING),
                    selfId
                });

        // 2. 查询待下载消息（按时间升序）
        cursor = db.query(DatabaseHelper.MESSAGES_TABLE,
                MessageData.getProjection(),
                DatabaseHelper.MessageColumns.STATUS + " IN (?, ?) AND "
                + DatabaseHelper.MessageColumns.SELF_PARTICIPANT_ID + " =?",
                new String[]{
                    Integer.toString(MessageData.BUGLE_STATUS_INCOMING_RETRYING_AUTO_DOWNLOAD),
                    Integer.toString(MessageData.BUGLE_STATUS_INCOMING_RETRYING_MANUAL_DOWNLOAD),
                    selfId
                },
                null, null,
                DatabaseHelper.MessageColumns.RECEIVED_TIMESTAMP + " ASC");

        // 3. 若无正在下载的消息，取最早的一条待下载消息
        if (downloadingCnt == 0 && cursor.moveToNext()) {
            final MessageData message = new MessageData();
            message.bind(cursor);
            toDownloadMessageId = message.getMessageId();
        }
        db.setTransactionSuccessful();
    } finally {
        db.endTransaction();
    }
    return toDownloadMessageId;
}
```

`ProcessPendingMessagesAction` 采用串行调度策略——同一时刻最多只有一条消息在下载。通过查询 `downloadingCnt` 来判断是否有下载正在进行，只有当没有下载任务时才取出下一条待下载消息。

| 扫描目标 | 查询的状态值 | 含义 |
|----------|-------------|------|
| 正在下载 | `AUTO_DOWNLOADING` (105), `MANUAL_DOWNLOADING` (103) | 判断是否已有下载进行中 |
| 待下载 | `RETRYING_AUTO_DOWNLOAD` (104), `RETRYING_MANUAL_DOWNLOAD` (102) | 可被调度下载的消息 |

### 7.6 DownloadMmsAction 消息状态转换

`DownloadMmsAction` 是实际执行 MMS 下载的 Action，负责消息从"待下载"到"下载中"再到"完成/失败"的完整状态转换。

状态转换图：

```
                 自动下载路径
RETRYING_AUTO_DOWNLOAD (104)
         │
         ▼
   AUTO_DOWNLOADING (105)
     │         │
     │ 成功    │ 失败
     ▼         ▼
  COMPLETE    RETRYING_AUTO_DOWNLOAD (104) ── 继续重试
  (100)           │
                  │ 超出下载窗口
                  ▼
            DOWNLOAD_FAILED (106)

                手动下载路径
RETRYING_MANUAL_DOWNLOAD (102)
         │
         ▼
   MANUAL_DOWNLOADING (103)
     │         │
     │ 成功    │ 失败
     ▼         ▼
  COMPLETE    RETRYING_MANUAL_DOWNLOAD (102) ── 等待用户重试
  (100)           │
                  │ 超出下载窗口
                  ▼
            DOWNLOAD_FAILED (106)
```

`queueAction()` 中的状态转换：

```java
// DownloadMmsAction.java (line 113-176)
protected boolean queueAction(final String messageId, final Action processingAction) {
    actionParameters.putString(KEY_MESSAGE_ID, messageId);
    final DatabaseWrapper db = DataModel.get().getDatabase();
    final MessageData message = BugleDatabaseOperations.readMessage(db, messageId);
    if (message != null && message.canDownloadMessage()) {
        final Uri notificationUri = message.getSmsMessageUri();
        final int status = message.getStatus();

        final long now = System.currentTimeMillis();
        if (message.getInDownloadWindow(now)) {
            // 在下载窗口内：转换为 downloading 状态
            final int downloadingStatus = getDownloadingStatus(status);
            updateMessageStatus(notificationUri, messageId, conversationId,
                    downloadingStatus, MessageData.RAW_TELEPHONY_STATUS_UNDEFINED);
            actionParameters.putInt(KEY_FAILURE_STATUS, getFailureStatus(downloadingStatus));
            processingAction.requestBackgroundWork(this);
            return true;
        } else {
            // 超出下载窗口：标记为下载失败
            updateMessageStatus(notificationUri, messageId, conversationId,
                    MessageData.BUGLE_STATUS_INCOMING_DOWNLOAD_FAILED,
                    MessageData.RAW_TELEPHONY_STATUS_UNDEFINED);
            if (status == MessageData.BUGLE_STATUS_INCOMING_RETRYING_AUTO_DOWNLOAD) {
                ProcessDownloadedMmsAction.sendDeferredRespStatus(
                        messageId, message.getMmsTransactionId(),
                        message.getMmsContentLocation(), subId);
                return true;
            }
        }
    }
    return false;
}
```

状态映射关系：

| 当前状态 | downloadingStatus | failureStatus |
|---------|-------------------|---------------|
| `RETRYING_AUTO_DOWNLOAD` (104) | `AUTO_DOWNLOADING` (105) | `RETRYING_AUTO_DOWNLOAD` (104) |
| `RETRYING_MANUAL_DOWNLOAD` (102) | `MANUAL_DOWNLOADING` (103) | `RETRYING_MANUAL_DOWNLOAD` (102) |

`doBackgroundWork()` 实际下载执行：

```java
// DownloadMmsAction.java (line 233)
@Override
protected Bundle doBackgroundWork() {
    final Context context = Factory.get().getApplicationContext();
    final MmsUtils.StatusPlusUri status = MmsUtils.downloadMmsMessage(context,
            notificationUri, subId, subPhoneNumber, transactionId, contentLocation,
            autoDownload, receivedTimestampRoundedToSecond / 1000L, expiry / 1000L, extras);

    if (status == MmsUtils.STATUS_PENDING) {
        // 异步下载：等待 PendingIntent 回调通知完成
    } else {
        // 同步下载失败：立即处理
        ProcessDownloadedMmsAction.processMessageDownloadFastFailed(messageId,
                notificationUri, conversationId, participantId, contentLocation,
                subId, subPhoneNumber, statusIfFailed, autoDownload, transactionId,
                status.resultCode);
    }
    return null;
}
```

下载完成后的后续处理（消息内容解析、附件保存、UI 更新等）由 `ProcessDownloadedMmsAction` 负责，根据下载结果将消息最终转换为 `INCOMING_COMPLETE`（成功）或回退到 `RETRYING_*`（失败可重试）/ `DOWNLOAD_FAILED`（失败不可重试）状态。


## 第8章 MmsService 下载请求

### 8.1 MmsService 架构概览

`MmsService` 是 Android 系统中处理 MMS（多媒体消息服务）API 请求的核心系统服务。它继承自 `android.app.Service`，同时实现 `MmsRequest.RequestManager` 接口，通过 `IMms.Stub` AIDL 接口将能力暴露给应用层（如 `Telephony` 框架层的 `SmsManager`）。

#### 8.1.1 双请求队列模型

MmsService 内部维护两个独立的线程池队列，分别处理发送和下载请求：

```java
public static final int QUEUE_INDEX_SEND = 0;
public static final int QUEUE_INDEX_DOWNLOAD = 1;
public static final int THREAD_POOL_SIZE = 4;

// Running request queues, one thread pool per queue
// 0: send queue
// 1: download queue
private final ExecutorService[] mRunningRequestExecutors = new ExecutorService[2];
```

| 队列索引 | 常量名 | 用途 | 线程数 |
|---------|--------|------|--------|
| 0 | `QUEUE_INDEX_SEND` | MMS 发送请求 | 4 |
| 1 | `QUEUE_INDEX_DOWNLOAD` | MMS 下载（接收）请求 | 4 |

每个队列拥有独立的 `ExecutorService`，发送与下载互不阻塞。这种设计确保了当大量下载请求（如批量 MMS 推送）涌入时，不会阻塞发送队列，反之亦然。

#### 8.1.2 单 SIM 串行约束

同一时刻，MmsService 只允许一个 `subId` 的请求在运行：

```java
// The current SIM ID for the running requests. Only one SIM can send/download MMS at a time.
private int mCurrentSubId;
// The current running MmsRequest count.
private int mRunningRequestCount;
```

这个设计的原因在于：MMS 网络请求需要通过特定的 MMS APN 建立数据连接，而不同 SIM 卡对应不同的运营商配置和网络通道，无法并行处理。当一个 SIM 的请求正在执行时，属于其他 SIM 的请求必须进入等待队列。

#### 8.1.3 AIDL 接口层

MmsService 通过 `IMms.Stub` 内部类实现 AIDL 接口，核心方法包括：

- `sendMessage()` -- 发送 MMS
- `downloadMessage()` -- 下载 MMS
- `addSimRequest()` -- 请求入队（内部方法）
- `importMms()` -- 导入 MMS

所有公共方法入口都首先调用 `enforceSystemUid()` 进行权限校验，确保只有系统进程（UID = Process.SYSTEM_UID）可以调用该服务。

---

### 8.2 downloadMessage() 入口方法

`downloadMessage()` 是 MMS 下载流程的入口，定义在 `IMms.Stub` 内部类中，负责接收来自 `SmsManager` 的下载请求并完成所有前置校验。

#### 8.2.1 方法签名

```java
@Override
public void downloadMessage(int subId, int callingUser, String callingPkg,
        String locationUrl, Uri contentUri, Bundle configOverrides,
        PendingIntent downloadedIntent, long messageId, String attributionTag)
```

| 参数 | 类型 | 说明 |
|------|------|------|
| `subId` | int | 目标 SIM 卡的订阅 ID |
| `callingUser` | int | 调用者用户 ID |
| `callingPkg` | String | 调用者包名 |
| `locationUrl` | String | MMS 内容下载 URL（从 WAP Push 通知中提取） |
| `contentUri` | Uri | MMS 内容在 telephony provider 中的 URI |
| `configOverrides` | Bundle | 运营商配置覆盖项 |
| `downloadedIntent` | PendingIntent | 下载完成的回调 PendingIntent |
| `messageId` | long | 跨堆栈消息 ID（用于日志追踪） |
| `attributionTag` | String | 归因标签 |

#### 8.2.2 完整执行流程

```java
@Override
public void downloadMessage(int subId, int callingUser, String callingPkg,
        String locationUrl, Uri contentUri, Bundle configOverrides,
        PendingIntent downloadedIntent, long messageId, String attributionTag) {
    // If the subId is no longer active it could be caused by an MVNO using multiple
    // subIds, so we should try to download anyway.
    LogUtil.d("downloadMessage: " + MmsHttpClient.redactUrlForNonVerbose(locationUrl)
            + ", " + formatCrossStackMessageId(messageId));

    // Step 1: 权限校验
    enforceSystemUid();

    // Step 2: 初始化 MmsStats 用于统计上报
    MmsStats mmsStats = new MmsStats(MmsService.this,
            mMmsMetricsCollector.getAtomsStorage(), subId,
            getTelephonyManager(subId), callingPkg, true, callingUser);

    // Step 3: subId 有效性校验
    if (!SubscriptionManager.isValidSubscriptionId(subId)) {
        LogUtil.e("Invalid subId " + subId);
        handleError(downloadedIntent, SmsManager.MMS_ERROR_INVALID_SUBSCRIPTION_ID, mmsStats);
        return;
    }
    if (subId == SubscriptionManager.DEFAULT_SUBSCRIPTION_ID) {
        subId = SubscriptionManager.getDefaultSmsSubscriptionId();
        mmsStats.updateSubId(subId, getTelephonyManager(subId));
    }

    // Step 4: MVNO 场景 -- 不活跃的 subId 尝试同组活跃 subId
    if (!isActiveSubId(subId)) {
        List<SubscriptionInfo> activeSubList = getActiveSubscriptionsInGroup(subId);
        if (activeSubList.isEmpty()) {
            handleError(downloadedIntent, SmsManager.MMS_ERROR_INACTIVE_SUBSCRIPTION, mmsStats);
            return;
        }
        subId = activeSubList.get(0).getSubscriptionId();
        int defaultSmsSubId = SubscriptionManager.getDefaultSmsSubscriptionId();
        for (SubscriptionInfo subInfo : activeSubList) {
            if (subInfo.getSubscriptionId() == defaultSmsSubId) {
                subId = subInfo.getSubscriptionId();
            }
        }
    }
    mmsStats.updateSubId(subId, getTelephonyManager(subId));

    // Step 5: 加载运营商 MMS 配置
    Bundle mmsConfig = loadMmsConfig(subId);
    if (mmsConfig == null) {
        handleError(downloadedIntent, SmsManager.MMS_ERROR_CONFIGURATION_ERROR, mmsStats);
        return;
    }

    // Step 6: 应用配置覆盖
    if (configOverrides != null) {
        mmsConfig.putAll(configOverrides);
    }

    // Step 7: 检查 MMS 是否启用
    if (!mmsConfig.getBoolean(SmsManager.MMS_CONFIG_MMS_ENABLED)) {
        handleError(downloadedIntent, SmsManager.MMS_ERROR_CONFIGURATION_ERROR, mmsStats);
        return;
    }

    // Step 8: 创建 DownloadRequest
    final DownloadRequest request = new DownloadRequest(MmsService.this, subId, locationUrl,
            contentUri, downloadedIntent, callingUser, callingPkg, mmsConfig,
            MmsService.this, messageId, mmsStats, getTelephonyManager(subId));

    // Step 9: 运营商 App 处理路径
    final String carrierMessagingServicePackage =
            getCarrierMessagingServicePackageIfExists(subId);
    if (carrierMessagingServicePackage != null) {
        request.tryDownloadingByCarrierApp(MmsService.this, carrierMessagingServicePackage);
        return;
    }

    // Step 10: MMS 数据可用性检查
    if (!getTelephonyManager(subId).isDataEnabledForApn(ApnSetting.TYPE_MMS)) {
        sendSettingsIntentForFailedMms(/*isIncoming=*/ true, subId);
        handleError(downloadedIntent, SmsManager.MMS_ERROR_DATA_DISABLED, mmsStats);
        return;
    }

    // Step 11: 入队执行
    addSimRequest(request);
}
```

#### 8.2.3 关键步骤解析

**权限校验（enforceSystemUid）**

```java
private void enforceSystemUid() {
    if (Binder.getCallingUid() != Process.SYSTEM_UID) {
        throw new SecurityException("Only system can call this service");
    }
}
```

MmsService 只接受系统 UID 的调用。普通应用无法直接调用，必须通过 `SmsManager` -> `Telephony` 框架 -> `IMms` AIDL 的链路间接使用。

**MVNO 场景处理**

MVNO（移动虚拟网络运营商）可能使用多个 `subId`，其中某些 `subId` 可能处于非活跃状态。代码通过 `getActiveSubscriptionsInGroup()` 查找同订阅组中的活跃 `subId`，优先选择默认短信 `subId`，确保下载不会因 `subId` 不活跃而失败。

**运营商 App 处理路径**

当设备安装了运营商提供的 `CarrierMessagingService` 时（且只有一个满足条件），下载请求将交由运营商 App 处理。这种情况下，MmsService 本身不执行下载，而是通过 `tryDownloadingByCarrierApp()` 委托给运营商服务。这是运营商定制化 MMS 行为的扩展点。

**MMS 数据可用性检查**

```java
if (!getTelephonyManager(subId).isDataEnabledForApn(ApnSetting.TYPE_MMS)) {
    sendSettingsIntentForFailedMms(/*isIncoming=*/ true, subId);
    handleError(downloadedIntent, SmsManager.MMS_ERROR_DATA_DISABLED, mmsStats);
    return;
}
```

当 MMS APN 的数据连接不可用时，系统会发送一个广播通知设置应用提示用户开启数据：

```java
private void sendSettingsIntentForFailedMms(boolean isIncoming, int subId) {
    Intent intent = new Intent(Settings.ACTION_ENABLE_MMS_DATA_REQUEST);
    intent.putExtra(Settings.EXTRA_ENABLE_MMS_DATA_REQUEST_REASON,
            isIncoming ? Settings.ENABLE_MMS_DATA_REQUEST_REASON_INCOMING_MMS
                    : Settings.ENABLE_MMS_DATA_REQUEST_REASON_OUTGOING_MMS);
    intent.putExtra(Settings.EXTRA_SUB_ID, subId);
    this.sendBroadcastAsUser(intent, UserHandle.SYSTEM,
            android.Manifest.permission.NETWORK_SETTINGS);
}
```

---

### 8.3 DownloadRequest 构造

#### 8.3.1 构造方法

```java
public DownloadRequest(RequestManager manager, int subId, String locationUrl,
        Uri contentUri, PendingIntent downloadedIntent, int callingUser, String creator,
        Bundle configOverrides, Context context, long messageId, MmsStats mmsStats,
        TelephonyManager telephonyManager) {
    super(manager, subId, creator, configOverrides, context, messageId, mmsStats,
            telephonyManager);
    mLocationUrl = locationUrl;
    mDownloadedIntent = downloadedIntent;
    mContentUri = contentUri;
    mCallingUser = callingUser;
}
```

#### 8.3.2 参数说明

| 参数 | 说明 |
|------|------|
| `manager` | `RequestManager` 接口（即 MmsService 实例），用于回调入队操作 |
| `subId` | SIM 卡订阅 ID |
| `locationUrl` | MMS 内容的下载 URL，从 WAP Push `m-notification.ind` 中提取 |
| `contentUri` | telephony provider 中 MMS 消息的 content URI，用于持久化和结果写入 |
| `downloadedIntent` | 下载完成后发送的 PendingIntent，通知调用方 |
| `callingUser` | 发起请求的用户 ID（多用户场景） |
| `creator` | 调用者包名 |
| `configOverrides` | 运营商配置覆盖项（Bundle） |
| `context` | Context 上下文 |
| `messageId` | 跨堆栈消息追踪 ID |
| `mmsStats` | MMS 统计数据收集器 |
| `telephonyManager` | 订阅特定的 TelephonyManager 实例 |

#### 8.3.3 DownloadRequest 与 SendRequest 的对比

| 特征 | DownloadRequest | SendRequest |
|------|----------------|-------------|
| HTTP 方法 | GET（从服务器拉取内容） | POST（向 MMSC 推送内容） |
| 核心参数 | `locationUrl`（下载地址） | PDU 字节数组（待发送编码数据） |
| 回调 Intent | `downloadedIntent` | `sentIntent` |
| 队列索引 | `QUEUE_INDEX_DOWNLOAD`(1) | `QUEUE_INDEX_SEND`(0) |
| prepareForHttpRequest | 从 contentUri 读取或准备接收 | 从 contentUri 读取并编码 PDU |
| doHttp() | `METHOD_GET`，pdu 参数为 null | `METHOD_POST`，携带 PDU 数据 |
| processResult | 解析 RetrieveConf，写入 provider | 更新发送状态 |
| 网络释放策略 | 成功后延迟释放（发送 NotifyRespInd） | 立即释放 |

---

### 8.4 请求队列管理

#### 8.4.1 核心数据结构

```java
// 等待队列：SIM 不匹配时暂存请求
private final Queue<MmsRequest> mPendingSimRequestQueue = new ArrayDeque<>();

// 当前运行的 SIM ID
private int mCurrentSubId;

// 当前运行请求计数
private int mRunningRequestCount;

// 双线程池执行器
private final ExecutorService[] mRunningRequestExecutors = new ExecutorService[2];
```

#### 8.4.2 addSimRequest() -- 请求入队

```java
@Override
public void addSimRequest(MmsRequest request) {
    if (request == null) {
        LogUtil.e("Add running or pending: empty request");
        return;
    }
    synchronized (this) {
        if (mPendingSimRequestQueue.size() > 0 ||
                (mRunningRequestCount > 0 && request.getSubId() != mCurrentSubId)) {
            // 条件1：等待队列不为空（说明已有请求等待）
            // 条件2：有请求正在运行，且新请求的 subId 与当前运行的 subId 不同
            // → 将请求加入等待队列
            mPendingSimRequestQueue.add(request);
            if (mRunningRequestCount <= 0) {
                movePendingSimRequestsToRunningSynchronized();
            }
        } else {
            // → 直接加入运行队列
            addToRunningRequestQueueSynchronized(request);
        }
    }
}
```

入队决策逻辑：

| 条件 | 处理方式 |
|------|---------|
| 等待队列非空 | 加入等待队列（FIFO 顺序） |
| 运行中请求的 subId 与新请求不同 | 加入等待队列（SIM 串行约束） |
| 等待队列为空 且 subId 匹配（或无运行中请求） | 直接加入运行队列 |

#### 8.4.3 addToRunningRequestQueueSynchronized() -- 入队执行

```java
private void addToRunningRequestQueueSynchronized(final MmsRequest request) {
    final int queue = request.getQueueType();
    mRunningRequestCount++;
    mCurrentSubId = request.getSubId();
    // Send to the corresponding request queue for execution
    mRunningRequestExecutors[queue].execute(new Runnable() {
        @Override
        public void run() {
            try {
                request.execute(MmsService.this, getNetworkManager(request.getSubId()));
            } finally {
                synchronized (MmsService.this) {
                    mRunningRequestCount--;
                    if (mRunningRequestCount <= 0) {
                        movePendingSimRequestsToRunningSynchronized();
                    }
                }
            }
        }
    });
}
```

关键点：
- 根据 `request.getQueueType()` 选择对应的线程池（Send=0, Download=1）
- 执行完毕后 `mRunningRequestCount` 递减
- 当所有运行中请求完成（`mRunningRequestCount <= 0`）时，触发等待队列的迁移

#### 8.4.4 movePendingSimRequestsToRunningSynchronized() -- 等待队列迁移

```java
private void movePendingSimRequestsToRunningSynchronized() {
    mCurrentSubId = SubscriptionManager.INVALID_SUBSCRIPTION_ID;
    while (mPendingSimRequestQueue.size() > 0) {
        final MmsRequest request = mPendingSimRequestQueue.peek();
        if (request != null) {
            if (!SubscriptionManager.isValidSubscriptionId(mCurrentSubId)
                    || mCurrentSubId == request.getSubId()) {
                // 同一 SIM 的请求连续取出执行
                mPendingSimRequestQueue.remove();
                addToRunningRequestQueueSynchronized(request);
            } else {
                // 遇到不同 SIM 的请求则停止，等待当前 SIM 全部完成
                break;
            }
        } else {
            mPendingSimRequestQueue.remove();
        }
    }
}
```

该方法的策略：
1. 重置 `mCurrentSubId` 为无效值
2. 从等待队列头部开始，连续取出同一 `subId` 的请求
3. 遇到第一个不同 `subId` 的请求时停止，保证 SIM 串行约束
4. 请求不重排序：如果 SIM1 正在运行，SIM2 的请求先入队列，随后 SIM1 的新请求也入队列，那么 SIM1 的新请求排在 SIM2 后面，不会被提前执行

#### 8.4.5 请求队列管理流程图

```
                          addSimRequest(request)
                                 |
                    +------------+-------------+
                    |                          |
            等待队列非空 或              等待队列为空 且
          subId 与运行中不同            subId 匹配/无运行请求
                    |                          |
          mPendingSimRequestQueue        addToRunningRequest
              .add(request)            QueueSynchronized(request)
                    |                          |
                    |                   mRunningRequestCount++
                    |                   mCurrentSubId = subId
                    |                          |
                    |              mRunningRequestExecutors[queue]
                    |                   .execute(runnable)
                    |                          |
                    |                   request.execute(...)
                    |                          |
                    |                     finally 块:
                    |                   mRunningRequestCount--
                    |                          |
                    |               mRunningRequestCount <= 0 ?
                    |                   /              \
                    |                 Yes               No
                    |                  |                |
                    |    movePendingSimRequests       (等待其他请求完成)
                    |    ToRunningSynchronized()
                    |                  |
                    |    重置 mCurrentSubId
                    |                  |
                    |    连续取出相同 subId 的请求
                    |                  |
                    |    addToRunningRequest
                    |    QueueSynchronized(...)
                    |                  |
                    +---<--- 遇到不同 subId 停止 ---+
                           (保留在等待队列)
```

---

## 第9章 下载执行与网络管理

### 9.1 MmsRequest 状态机

#### 9.1.1 状态枚举定义

`MmsRequest` 定义了 8 个状态枚举，构成了请求执行的完整生命周期：

```java
protected enum MmsRequestState {
    Unknown,              // 初始状态，未开始
    Created,              // 请求对象已创建
    PrepareForHttpRequest, // 准备阶段：读取 PDU、参数校验等
    AcquiringNetwork,     // 正在获取 MMS 网络
    LoadingApn,           // 正在加载 APN 配置
    DoingHttp,            // 正在执行 HTTP 请求
    Success,              // 执行成功
    Failure               // 执行失败
};
protected MmsRequestState currentState = MmsRequestState.Unknown;
```

#### 9.1.2 状态转换图

```
                    +-----------+
                    |  Unknown  |  请求对象初始状态
                    +-----------+
                          |
                    构造完成
                          |
                    +-----------+
                    |  Created  |
                    +-----------+
                          |
                    execute() 被调用
                          |
              +-----------+-----------+
              |                       |
        prepareForHttpRequest()    prepareForHttpRequest()
              成功                     失败
              |                       |
              |                 +-----------+
              |                 |  Failure  |
              |                 +-----------+
              |
              v
    +---------------------+     重试循环开始（最多 RETRY_TIMES=3 次）
    | PrepareForHttpRequest|<----+
    +---------------------+
              |
              v
    +---------------------+
    |  AcquiringNetwork   |   networkManager.acquireNetwork()
    +---------------------+
              |
              v
    +---------------------+
    |    LoadingApn       |   加载 APN 配置（优先从网络回调获取，回退到数据库查询）
    +---------------------+
              |
              v
    +---------------------+
    |     DoingHttp       |   doHttp() -- HTTP GET/POST
    +---------------------+
              |
         +----+----+
         |         |
      成功      失败（可重试）
         |         |
         v         |
    +-----------+   |
    |  Success  |   |
    +-----------+   |
         |         |
         |    MmsHttpException → 重试（retryDelaySecs <<= 1）
         |    其他异常 → 直接失败
         |         |
         |    retryId < RETRY_TIMES?
         |      /       \
         |    Yes        No
         |     |          |
         +--冷却等待--+     v
                  |   +-----------+
                  +-->|  Failure  |
                      +-----------+
```

#### 9.1.3 各状态说明

| 状态 | 说明 | 退出条件 |
|------|------|---------|
| `Unknown` | 对象刚创建，尚未初始化 | 进入 `Created` |
| `Created` | 构造函数完成，字段已初始化 | `execute()` 被调用 |
| `PrepareForHttpRequest` | 准备 HTTP 请求所需的资源（如读取 PDU 数据） | 成功进入重试循环，失败进入 `Failure` |
| `AcquiringNetwork` | 通过 `MmsNetworkManager` 获取 MMS 专用网络 | 获取成功进入 `LoadingApn`，失败抛出 `MmsNetworkException` |
| `LoadingApn` | 加载 MMS APN 配置信息 | 加载成功进入 `DoingHttp`，失败抛出 `ApnException` |
| `DoingHttp` | 执行 HTTP 请求（GET 下载 / POST 发送） | 成功进入 `Success`，失败抛出 `MmsHttpException` 或其他异常 |
| `Success` | 整个请求流程成功完成 | 终态 |
| `Failure` | 请求因异常或超限失败 | 终态 |

---

### 9.2 execute() 方法核心流程

`execute()` 是 `MmsRequest` 的核心方法，封装了 MMS 请求的完整执行逻辑，包括准备、重试、网络获取、APN 加载、HTTP 执行和结果处理。

#### 9.2.1 完整代码

```java
public void execute(Context context, MmsNetworkManager networkManager) {
    final String requestId = this.getRequestId();
    LogUtil.i(requestId, "Executing...");
    result = SmsManager.MMS_ERROR_UNSPECIFIED;
    httpStatusCode = 0;
    byte[] response = null;
    int retryId = 0;
    currentState = MmsRequestState.PrepareForHttpRequest;

    if (!prepareForHttpRequest()) { // Prepare request, like reading pdu data from user
        LogUtil.e(requestId, "Failed to prepare for request");
        result = SmsManager.MMS_ERROR_IO_ERROR;
    } else { // Execute
        long retryDelaySecs = 2;
        // Try multiple times of MMS HTTP request, depending on the error.
        for (retryId = 0; retryId < RETRY_TIMES; retryId++) {
            httpStatusCode = 0; // Clear for retry.
            MonitorTelephonyCallback connectionStateCallback = new MonitorTelephonyCallback();
            try {
                listenToDataConnectionState(connectionStateCallback);
                currentState = MmsRequestState.AcquiringNetwork;
                int networkId = networkManager.acquireNetwork(requestId);
                currentState = MmsRequestState.LoadingApn;
                ApnSettings apn = null;
                ApnSetting networkApn = null;
                synchronized (connectionStateCallback.mLock) {
                    networkApn = connectionStateCallback.mNetworkIdToApn.get(networkId);
                }
                if (networkApn != null) {
                    apn = ApnSettings.getApnSettingsFromNetworkApn(networkApn);
                }
                if (apn == null) {
                    final String apnName = networkManager.getApnName();
                    try {
                        apn = ApnSettings.load(context, apnName, mSubId, requestId);
                    } catch (ApnException e) {
                        if (apnName == null) {
                            throw (e);
                        }
                        apn = ApnSettings.load(context, null, mSubId, requestId);
                    }
                }

                LogUtil.d(requestId, "Using APN " + apn);
                if (networkManager.isSatelliteTransport()
                        && !canTransferPayloadOnCurrentNetwork()) {
                    LogUtil.e(requestId, "PDU too large for satellite");
                    result = SmsManager.MMS_ERROR_TOO_LARGE_FOR_TRANSPORT;
                    break;
                }
                currentState = MmsRequestState.DoingHttp;
                response = doHttp(context, networkManager, apn);
                result = Activity.RESULT_OK;
                // Success
                break;
            } catch (ApnException e) {
                result = SmsManager.MMS_ERROR_INVALID_APN;
                break;                          // APN 错误不重试
            } catch (MmsNetworkException e) {
                result = SmsManager.MMS_ERROR_UNABLE_CONNECT_MMS;
                break;                          // 网络获取失败不重试
            } catch (MmsHttpException e) {
                result = SmsManager.MMS_ERROR_HTTP_FAILURE;
                httpStatusCode = e.getStatusCode();
                // Retry -- HTTP 异常可重试
            } catch (Exception e) {
                result = SmsManager.MMS_ERROR_UNSPECIFIED;
                break;                          // 未预期异常不重试
            } finally {
                // Release the MMS network immediately except successful DownloadRequest.
                networkManager.releaseNetwork(requestId,
                        this instanceof DownloadRequest
                                && result == Activity.RESULT_OK);
                stopListeningToDataConnectionState(connectionStateCallback);
            }

            if (result != Activity.RESULT_CANCELED) {
                try {
                    new CountDownLatch(1).await(retryDelaySecs, TimeUnit.SECONDS);
                } catch (InterruptedException e) { }
                retryDelaySecs <<= 1;
            }
        }
    }
    processResult(context, result, response, httpStatusCode,
            /* handledByCarrierApp= */ false, retryId);
}
```

#### 9.2.2 阶段详解

**PrepareForHttpRequest 阶段**

这是请求执行的第一个阶段。`prepareForHttpRequest()` 是一个抽象方法，由 `DownloadRequest` 和 `SendRequest` 分别实现：
- `DownloadRequest`：从 `contentUri` 读取消息内容或准备接收缓冲
- `SendRequest`：从 `contentUri` 读取 PDU 数据并编码

如果此阶段失败，直接设置 `MMS_ERROR_IO_ERROR` 并跳过重试循环。

**重试循环（最多 3 次）**

```java
private static final int RETRY_TIMES = 3;
long retryDelaySecs = 2;
for (retryId = 0; retryId < RETRY_TIMES; retryId++) { ... }
```

重试策略采用指数退避（Exponential Backoff）：
- 第 1 次重试：等待 2 秒
- 第 2 次重试：等待 4 秒（`retryDelaySecs <<= 1`，即左移 1 位，等价于 x2）
- 第 3 次重试：等待 8 秒

**AcquiringNetwork 阶段**

调用 `networkManager.acquireNetwork()` 获取 MMS 专用网络。该方法会阻塞等待网络可用。如果超时或失败，抛出 `MmsNetworkException`，该异常**不触发重试**。

**LoadingApn 阶段**

APN 加载采用两级策略：
1. 首先尝试从 `MonitorTelephonyCallback` 监听的数据连接状态回调中获取 `ApnSetting`（实时网络层信息）
2. 如果获取不到，回退到通过 `ApnSettings.load()` 从数据库查询（传入网络名称）
3. 如果带名称查询失败，尝试不传名称的兜底查询

**DoingHttp 阶段**

调用抽象方法 `doHttp()` 执行实际的网络请求。`DownloadRequest` 使用 HTTP GET，`SendRequest` 使用 HTTP POST。

**卫星网络载荷大小检查**

```java
if (networkManager.isSatelliteTransport()
        && !canTransferPayloadOnCurrentNetwork()) {
    result = SmsManager.MMS_ERROR_TOO_LARGE_FOR_TRANSPORT;
    break;
}
```

卫星网络带宽受限，MmsRequest 定义了卫星传输的大小限制：

```java
public int SATELLITE_MMS_SIZE_LIMIT = 3 * 1024;  // 3KB
```

当通过卫星网络传输时，会在 `DoingHttp` 之前检查载荷是否超过限制。

**finally 块 -- 网络释放**

```java
finally {
    networkManager.releaseNetwork(requestId,
            this instanceof DownloadRequest
                    && result == Activity.RESULT_OK);
    stopListeningToDataConnectionState(connectionStateCallback);
}
```

每次重试迭代结束后都会释放网络。但对于成功的 `DownloadRequest`，`shouldDelayRelease` 设为 `true`，延迟释放网络以便后续发送 `NotifyRespInd` 确认。

**processResult() 回调**

重试循环结束后（无论成功或失败），调用 `processResult()` 进行最终结果处理。该方法同样是抽象的：
- `DownloadRequest`：解析 `RetrieveConf` PDU，将消息内容写入 telephony provider，发送 `downloadedIntent` 回调
- `SendRequest`：更新消息发送状态，发送 `sentIntent` 回调

#### 9.2.3 异常类型与重试策略

| 异常类型 | 错误码 | 是否重试 | 说明 |
|---------|--------|---------|------|
| `MmsHttpException` | `MMS_ERROR_HTTP_FAILURE` | **是** | HTTP 请求失败（如服务端错误、超时），记录 HTTP 状态码，进入重试 |
| `MmsNetworkException` | `MMS_ERROR_UNABLE_CONNECT_MMS` | **否** | 网络获取阶段失败（超时、无可用网络），直接退出 |
| `ApnException` | `MMS_ERROR_INVALID_APN` | **否** | APN 配置加载失败，直接退出 |
| `Exception`（其他） | `MMS_ERROR_UNSPECIFIED` | **否** | 未预期的运行时异常，直接退出 |

`MmsHttpException` 与 `MmsNetworkException` 的核心区别：
- `MmsHttpException`：发生在 HTTP 传输阶段，网络连接已建立，但请求本身失败（如 MMSC 返回 5xx 错误、连接超时等），这类错误可能是暂时性的，值得重试
- `MmsNetworkException`：发生在网络获取阶段，MMS 专用网络无法建立（如数据未开启、SIM 卡异常等），这类错误通常是持续性故障，重试无意义

---

### 9.3 DownloadRequest.doHttp() 实现

#### 9.3.1 方法实现

```java
@Override
protected byte[] doHttp(Context context, MmsNetworkManager netMgr, ApnSettings apn)
        throws MmsHttpException {
    final String requestId = getRequestId();
    final MmsHttpClient mmsHttpClient = netMgr.getOrCreateHttpClient();
    if (mmsHttpClient == null) {
        throw new MmsHttpException(0/*statusCode*/, "MMS network is not ready. "
                + MmsService.formatCrossStackMessageId(mMessageId));
    }
    return mmsHttpClient.execute(
            mLocationUrl,
            null/*pud*/,
            MmsHttpClient.METHOD_GET,
            apn.isProxySet(),
            apn.getProxyAddress(),
            apn.getProxyPort(),
            mMmsConfig,
            mSubId,
            requestId);
}
```

#### 9.3.2 参数传递说明

| MmsHttpClient.execute() 参数 | DownloadRequest 传入值 | 说明 |
|------------------------------|----------------------|------|
| `url` | `mLocationUrl` | MMS 内容下载 URL（从 WAP Push 通知中提取） |
| `pdu` | `null` | GET 请求不携带 PDU 载荷 |
| `method` | `MmsHttpClient.METHOD_GET` | HTTP GET 方法 |
| `isProxySet` | `apn.isProxySet()` | 是否使用代理（由 APN 配置决定） |
| `proxyAddress` | `apn.getProxyAddress()` | MMS 代理地址（如 `10.0.0.172`） |
| `proxyPort` | `apn.getProxyPort()` | MMS 代理端口 |
| `mmsConfig` | `mMmsConfig` | 运营商 MMS 配置（User-Agent、UAProf 等） |
| `subId` | `mSubId` | SIM 卡订阅 ID |
| `requestId` | `getRequestId()` | 请求唯一标识（用于日志追踪） |

`getOrCreateHttpClient()` 返回绑定到当前 MMS 网络的 `MmsHttpClient` 实例。如果网络不可用（`mNetwork == null`），返回 `null`，此时会抛出 `MmsHttpException`。

---

### 9.4 MmsNetworkManager 网络请求构建

#### 9.4.1 NetworkRequest 构建过程

`MmsNetworkManager` 在构造函数中构建 `NetworkRequest`，定义了对 MMS 网络的精确需求：

```java
protected MmsNetworkManager(Context context, int subId, Dependencies dependencies) {
    mContext = context;
    mDeps = dependencies;
    mSubId = subId;
    mReleaseHandler = new Handler(Looper.getMainLooper());

    NetworkRequest.Builder builder = new NetworkRequest.Builder()
            .addTransportType(NetworkCapabilities.TRANSPORT_CELLULAR)
            .addCapability(NetworkCapabilities.NET_CAPABILITY_MMS)
            .setNetworkSpecifier(new TelephonyNetworkSpecifier.Builder()
                    .setSubscriptionId(mSubId).build());

    // With Satellite internet support
    builder.removeCapability(NetworkCapabilities.NET_CAPABILITY_NOT_RESTRICTED);
    builder.addTransportType(NetworkCapabilities.TRANSPORT_SATELLITE);
    builder.removeCapability(NetworkCapabilities
            .NET_CAPABILITY_NOT_BANDWIDTH_CONSTRAINED);
    mNetworkRequest = builder.build();

    // ...
}
```

#### 9.4.2 NetworkRequest 能力解析

| 设置项 | 值 | 说明 |
|--------|-----|------|
| `addTransportType(TRANSPORT_CELLULAR)` | 蜂窝传输 | MMS 默认通过蜂窝网络传输 |
| `addCapability(NET_CAPABILITY_MMS)` | MMS 能力 | 请求具备 MMS 能力的网络（通过 MMS APN 建立） |
| `setNetworkSpecifier(TelephonyNetworkSpecifier)` | 绑定 subId | 精确指定使用哪个 SIM 卡的网络 |
| `addTransportType(TRANSPORT_SATELLITE)` | 卫星传输 | 支持通过卫星网络传输 MMS |
| `removeCapability(NET_CAPABILITY_NOT_RESTRICTED)` | 允许受限网络 | 卫星网络通常是受限网络，移除此限制以允许匹配 |
| `removeCapability(NET_CAPABILITY_NOT_BANDWIDTH_CONSTRAINED)` | 允许带宽受限 | 卫星网络带宽受限，移除此限制以允许匹配 |

#### 9.4.3 卫星网络支持

卫星 MMS 支持的引入使 `NetworkRequest` 的构建变得更为复杂。卫星网络（`TRANSPORT_SATELLITE`）默认被视为：
- **受限网络**（restricted network）-- 通常不会匹配带有 `NET_CAPABILITY_NOT_RESTRICTED` 的请求
- **带宽受限网络**（bandwidth constrained）-- 不满足高带宽需求

因此需要主动移除这两个能力限制，使 `NetworkRequest` 能够同时匹配蜂窝 MMS 网络和卫星 MMS 网络。

---

### 9.5 acquireNetwork() 请求流程

#### 9.5.1 完整代码

```java
public int acquireNetwork(final String requestId) throws MmsNetworkException {
    int networkRequestTimeoutMillis = mDeps.getNetworkRequestTimeoutMillis();

    synchronized (this) {
        // Since we are acquiring the network, remove the network release task if exists.
        mReleaseHandler.removeCallbacks(mNetworkReleaseTask);
        mMmsRequestCount += 1;
        if (mNetwork != null) {
            // Already available
            LogUtil.d(requestId, "MmsNetworkManager: already available");
            return mNetwork.getNetId();
        }

        if (!mSimCardStateChangedReceiverRegistered) {
            mPhoneId = mDeps.getPhoneId(mSubId);
            if (mPhoneId == SubscriptionManager.INVALID_PHONE_INDEX
                    || mPhoneId == SubscriptionManager.DEFAULT_PHONE_INDEX) {
                throw new MmsNetworkException("Invalid Phone Id: " + mPhoneId);
            }
            mContext.registerReceiver(
                    mSimCardStateChangedReceiver,
                    new IntentFilter(TelephonyManager.ACTION_SIM_CARD_STATE_CHANGED));
            mSimCardStateChangedReceiverRegistered = true;
        }

        // Not available, so start a new request if not done yet
        if (mNetworkCallback == null) {
            LogUtil.d(requestId, "MmsNetworkManager: start new network request");
            startNewNetworkRequestLocked(networkRequestTimeoutMillis);
        }

        try {
            this.wait(networkRequestTimeoutMillis
                    + mDeps.getAdditionalNetworkAcquireTimeoutMillis());
        } catch (InterruptedException e) {
            LogUtil.w(requestId, "MmsNetworkManager: acquire network wait interrupted");
        }

        if (mSimCardStateChangedReceiverRegistered) {
            mContext.unregisterReceiver(mSimCardStateChangedReceiver);
            mSimCardStateChangedReceiverRegistered = false;
        }

        if (mNetwork != null) {
            return mNetwork.getNetId();
        }

        if (mNetworkCallback != null) { // Timed out
            LogUtil.e(requestId,
                    "MmsNetworkManager: timed out with networkRequestTimeoutMillis="
                            + networkRequestTimeoutMillis
                            + " and ADDITIONAL_NETWORK_ACQUIRE_TIMEOUT_MILLIS="
                            + mDeps.getAdditionalNetworkAcquireTimeout_MILLIS());
            releaseRequestLocked(mNetworkCallback);
            this.notifyAll();
        }

        throw new MmsNetworkException("Acquiring network failed");
    }
}
```

#### 9.5.2 流程解析

```
acquireNetwork(requestId)
       |
       v
  移除延迟释放任务（防止已排定的释放被触发）
       |
       v
  mMmsRequestCount += 1
       |
       v
  mNetwork != null ?  ----Yes----> 返回 mNetwork.getNetId()
       |                            (网络已可用，直接返回)
       No
       |
       v
  验证 PhoneId 有效性
  注册 SIM 卡状态变化广播监听器
       |
       v
  mNetworkCallback == null ?
       |
      Yes --> startNewNetworkRequestLocked()
              (首次注册网络请求到 ConnectivityManager)
       |
       v
  this.wait(networkRequestTimeoutMillis + 5秒)
       |
       +---> 被 NetworkRequestCallback.onCapabilitiesChanged 唤醒
       |           (网络变为可用)
       |
       +---> 被 NetworkRequestCallback.onUnavailable 唤醒
       |           (网络请求被拒绝)
       |
       +---> 等待超时
       |
       v
  注销 SIM 卡状态广播监听器
       |
       v
  mNetwork != null ?
       |
      Yes --> 返回 mNetwork.getNetId()  (成功)
       |
       No
       |
       v
  超时处理：释放网络请求，唤醒所有等待线程
       |
       v
  抛出 MmsNetworkException
```

#### 9.5.3 超时机制

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `networkRequestTimeoutMillis` | 30 分钟 (`DEFAULT_MMS_SERVICE_NETWORK_REQUEST_TIMEOUT_MILLIS`) | ConnectivityManager 请求网络的超时 |
| `ADDITIONAL_NETWORK_ACQUIRE_TIMEOUT_MILLIS` | 5 秒 | 额外等待时间，防止过早退出 |

总等待时间为 `networkRequestTimeoutMillis + 5秒`。之所以需要额外 5 秒的缓冲，是因为 `networkRequestTimeoutMillis` 是传给 `ConnectivityManager.requestNetwork()` 的超时，网络回调可能在超时后稍晚到达，`acquireNetwork()` 需要额外等待以确保不遗漏最后的回调。

#### 9.5.4 引用计数机制

```java
mMmsRequestCount += 1;
```

`mMmsRequestCount` 是一个简单的引用计数器，记录当前有多少个 MMS 请求正在使用网络。当计数器降为 0 时，才会真正释放网络资源。这保证了多个并行请求（同一 SIM 的发送和下载）不会互相干扰对方的网络连接。

---

### 9.6 NetworkRequestCallback 回调处理

`NetworkRequestCallback` 是 `ConnectivityManager.NetworkCallback` 的内部子类，负责监听 MMS 网络的状态变化。

#### 9.6.1 完整代码

```java
private class NetworkRequestCallback extends ConnectivityManager.NetworkCallback {
    @Override
    public void onLost(Network network) {
        super.onLost(network);
        synchronized (MmsNetworkManager.this) {
            if (network.equals(mNetwork)) {
                mNetwork = null;
                mMmsHttpClient = null;
            }
        }
    }

    @Override
    public void onUnavailable() {
        super.onUnavailable();
        synchronized (MmsNetworkManager.this) {
            releaseRequestLocked(this);
            MmsNetworkManager.this.notifyAll();
        }
    }

    @Override
    public void onCapabilitiesChanged(Network network, NetworkCapabilities nc) {
        super.onCapabilitiesChanged(network, nc);
        synchronized (MmsNetworkManager.this) {
            final boolean isAvailable =
                    nc.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_SUSPENDED);
            if (network.equals(mNetwork) && !isAvailable) {
                // Current network becomes suspended.
                mNetwork = null;
                mMmsHttpClient = null;
                return;
            }

            // New available network
            if (mNetwork == null && isAvailable) {
                mIsSatelliteTransport = nc.hasTransport(
                        NetworkCapabilities.TRANSPORT_SATELLITE);
                mNetwork = network;
                MmsNetworkManager.this.notifyAll();
            }
        }
    }
}
```

#### 9.6.2 回调事件解析

| 回调方法 | 触发条件 | 处理逻辑 |
|---------|---------|---------|
| `onCapabilitiesChanged` | 网络能力发生变化（包括首次 `onAvailable` 之后的首次能力通知） | 检查 `NET_CAPABILITY_NOT_SUSPENDED`，如果可用则设置 `mNetwork` 并唤醒等待线程 |
| `onLost` | 当前网络丢失 | 清空 `mNetwork` 和 `mMmsHttpClient`，**不唤醒**（等待其他网络变为可用） |
| `onUnavailable` | 网络请求无法满足（无匹配网络） | 释放网络请求，唤醒所有等待线程（让它们以失败退出） |

#### 9.6.3 关键设计细节

**onCapabilitiesChanged 作为主可用性判断点**

`onAvailable` 会立即被 `onCapabilitiesChanged` 跟随，因此只在 `onCapabilitiesChanged` 中判断网络可用性。判断标准是 `NET_CAPABILITY_NOT_SUSPENDED`：

```java
final boolean isAvailable =
        nc.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_SUSPENDED);
```

网络可能处于挂起状态（suspended），例如数据连接建立中或暂时不可用。只有非挂起状态才被认为是真正可用的。

**onLost 不唤醒等待线程**

当网络丢失时，不清空等待队列中的请求。系统可能会重新建立网络连接，等待线程会在新网络的 `onCapabilitiesChanged` 中被唤醒，或在超时后退出。

**mIsSatelliteTransport 标记**

```java
mIsSatelliteTransport = nc.hasTransport(NetworkCapabilities.TRANSPORT_SATELLITE);
```

当新网络可用时，记录该网络是否为卫星传输。这个标记后续在 `execute()` 中用于卫星载荷大小检查：

```java
if (networkManager.isSatelliteTransport()
        && !canTransferPayloadOnCurrentNetwork()) {
    result = SmsManager.MMS_ERROR_TOO_LARGE_FOR_TRANSPORT;
    break;
}
```

---

### 9.7 releaseNetwork() 网络释放

#### 9.7.1 完整代码

```java
public void releaseNetwork(final String requestId, final boolean shouldDelayRelease) {
    synchronized (this) {
        if (mMmsRequestCount > 0) {
            mMmsRequestCount -= 1;
            LogUtil.d(requestId, "MmsNetworkManager: release, count=" + mMmsRequestCount);
            if (mMmsRequestCount < 1) {
                if (shouldDelayRelease) {
                    mReleaseHandler.removeCallbacks(mNetworkReleaseTask);
                    mReleaseHandler.postDelayed(mNetworkReleaseTask,
                            mNetworkReleaseTimeoutMillis);
                } else {
                    releaseRequestLocked(mNetworkCallback);
                }
            }
        }
    }
}
```

#### 9.7.2 延迟释放机制

`shouldDelayRelease` 参数是 `DownloadRequest` 特有的优化。当 MMS 下载成功后，网络需要暂时保持以便发送 `NotifyRespInd` 确认消息（告知 MMSC 消息已被成功接收）。

延迟释放通过 `mReleaseHandler.postDelayed` 实现：

```java
mNetworkReleaseTask = new Runnable() {
    @Override
    public void run() {
        synchronized (this) {
            if (mMmsRequestCount < 1) {
                releaseRequestLocked(mNetworkCallback);
            }
        }
    }
};
```

释放流程：
1. `execute()` 的 finally 块调用 `releaseNetwork(requestId, true)`
2. `mMmsRequestCount` 递减
3. 如果计数 < 1，不立即释放，而是通过主线程 Handler 延迟 `mNetworkReleaseTimeoutMillis` 后执行释放
4. 在延迟期间，如果有新的 `acquireNetwork()` 调用，会通过 `mReleaseHandler.removeCallbacks(mNetworkReleaseTask)` 取消待定的释放任务

#### 9.7.3 releaseRequestLocked() 释放实现

```java
private void releaseRequestLocked(ConnectivityManager.NetworkCallback callback) {
    if (callback != null) {
        final ConnectivityManager connectivityManager = getConnectivityManager();
        try {
            connectivityManager.unregisterNetworkCallback(callback);
        } catch (IllegalArgumentException e) {
            LogUtil.w("Unregister network callback exception", e);
        }
    }
    resetLocked();
}

private void resetLocked() {
    mNetworkCallback = null;
    mNetwork = null;
    mMmsRequestCount = 0;
    mMmsHttpClient = null;
}
```

释放操作会：
1. 向 `ConnectivityManager` 注销 `NetworkCallback`，释放网络资源
2. 重置所有内部状态（网络引用、回调、计数器、HTTP 客户端）
3. 捕获 `IllegalArgumentException`，防止 `unregisterNetworkCallback` 因已失效的回调而崩溃

#### 9.7.4 释放策略对比

| 场景 | shouldDelayRelease | 行为 |
|------|--------------------|----|
| DownloadRequest 成功 | `true` | 延迟释放（等待 NotifyRespInd） |
| DownloadRequest 失败 | `false` | 立即释放 |
| SendRequest（成功或失败） | `false` | 立即释放 |
| 重试中间迭代 | `false` | 每次重试后释放，下次重试重新获取 |

这种设计确保了 MMS 下载确认可以在同一网络通道上发送，避免重新建网的开销和时延。


---

## 第10章 MMSC 通信与彩信持久化

彩信下载的完整生命周期始于应用层发起的下载请求，经由系统框架的跨进程调用进入 `MmsService`，再由 `MmsHttpClient` 通过 HTTP GET 请求从 MMSC（MMS Centre）服务器获取消息内容（RetrieveConf PDU），最终经过 PDU 解析、数据库持久化和 UI 状态更新，完成一条彩信从网络到用户界面的完整旅程。

本章将从调用链出发，逐层深入 HTTP 通信、IPv4 等待机制、PDU 持久化、结果处理和 NotifyRespInd 确认发送等核心环节，揭示 Android 彩信下载的完整技术细节。

---

### 10.1 从应用到 MmsService 的调用链

#### 10.1.1 MmsUtils.downloadMmsMessage() -- 入口构造

`MmsUtils.downloadMmsMessage()` 是 Messaging 应用侧发起彩信下载的总入口。该方法首先进行前置检查（内容位置 URL 为空或无数据连接时直接返回失败），然后构造一个 `Bundle extras`，将所有下载所需的元数据打包进去：

```java
// MmsUtils.java
if (extras == null) {
    extras = new Bundle();
}
extras.putParcelable(DownloadMmsAction.EXTRA_NOTIFICATION_URI, notificationUri);
extras.putInt(DownloadMmsAction.EXTRA_SUB_ID, subId);
extras.putString(DownloadMmsAction.EXTRA_SUB_PHONE_NUMBER, subPhoneNumber);
extras.putString(DownloadMmsAction.EXTRA_TRANSACTION_ID, transactionId);
extras.putString(DownloadMmsAction.EXTRA_CONTENT_LOCATION, contentLocation);
extras.putBoolean(DownloadMmsAction.EXTRA_AUTO_DOWNLOAD, autoDownload);
extras.putLong(DownloadMmsAction.EXTRA_RECEIVED_TIMESTAMP, receivedTimestampInSeconds);
extras.putLong(DownloadMmsAction.EXTRA_EXPIRY, expiry);

MmsSender.downloadMms(context, subId, contentLocation, extras);
return STATUS_PENDING; // 下载异步执行，立即返回 PENDING 状态
```

extras Bundle 中包含的关键字段说明：

| 字段 | 含义 |
|------|------|
| `EXTRA_NOTIFICATION_URI` | 通知消息（M-Notification.ind）在 telephony provider 中的 URI |
| `EXTRA_SUB_ID` | SIM 卡订阅 ID |
| `EXTRA_SUB_PHONE_NUMBER` | SIM 卡电话号码 |
| `EXTRA_TRANSACTION_ID` | 事务 ID（用于后续 NotifyRespInd 确认） |
| `EXTRA_CONTENT_LOCATION` | MMSC 上的消息下载 URL |
| `EXTRA_AUTO_DOWNLOAD` | 是否为自动下载 |
| `EXTRA_RECEIVED_TIMESTAMP` | WAP Push 接收时间戳（秒） |
| `EXTRA_EXPIRY` | 消息过期时间 |

#### 10.1.2 MmsSender.downloadMms() -- PendingIntent 构造

`MmsSender.downloadMms()` 负责构造 `PendingIntent` 并将请求转发给 `MmsManager`：

```java
// MmsSender.java
public static void downloadMms(final Context context, final int subId,
        final String contentLocation, Bundle extras) throws MmsFailureException,
        InvalidHeaderValueException {
    final Uri requestUri = Uri.parse(contentLocation);
    final Uri contentUri = MmsFileProvider.buildRawMmsUri();

    final Intent downloadedIntent = new Intent(SendStatusReceiver.MMS_DOWNLOADED_ACTION,
            requestUri, context, SendStatusReceiver.class);
    downloadedIntent.putExtra(SendMessageAction.EXTRA_CONTENT_URI, contentUri);
    if (extras != null) {
        downloadedIntent.putExtras(extras);
    }
    final PendingIntent downloadedPendingIntent = PendingIntent.getBroadcast(
            context, 0 /*request code*/, downloadedIntent,
            PendingIntent.FLAG_UPDATE_CURRENT);

    MmsManager.downloadMultimediaMessage(subId, context, contentLocation, contentUri,
            downloadedPendingIntent);
}
```

该方法的核心职责：
1. 通过 `MmsFileProvider.buildRawMmsUri()` 创建一个临时文件 URI，用于平台层写入下载到的 PDU 数据
2. 构造一个指向 `SendStatusReceiver` 的广播 `PendingIntent`，平台下载完成后将通过此 Intent 回调应用
3. 将 extras 中的元数据一并放入 Intent，确保回调时能恢复完整上下文

#### 10.1.3 MmsManager.downloadMultimediaMessage() -- 分支路由

`MmsManager` 是 MMS 兼容库的统一出口，它根据平台能力选择不同的执行路径：

```java
// MmsManager.java (android/support/v7/mms/MmsManager.java)
public static void downloadMultimediaMessage(int subId, Context context, String locationUrl,
        Uri contentUri, PendingIntent downloadedIntent) {
    if (shouldUseLegacyMms()) {
        MmsService.startRequest(context,
                new DownloadRequest(locationUrl, contentUri, downloadedIntent));
    } else {
        subId = Utils.getEffectiveSubscriptionId(subId);
        final SmsManager smsManager = Utils.getSmsManager(subId);
        smsManager.downloadMultimediaMessage(context, locationUrl, contentUri,
                getConfigOverrides(subId), downloadedIntent);
    }
}

public static boolean shouldUseLegacyMms() {
    return sForceLegacyMms || !Utils.hasMmsApi();
}
```

两条路径的对比：

| 路径 | 条件 | 实现 |
|------|------|------|
| **Legacy 路径** | `sForceLegacyMms == true` 或平台不支持 MMS API（`!Utils.hasMmsApi()`） | 直接创建 `DownloadRequest`，在应用进程内通过 `MmsService`（兼容库版本）执行下载 |
| **平台 API 路径** | 平台支持 MMS API（Android L+） | 通过 `SmsManager.downloadMultimediaMessage()` 走系统服务，跨进程调用 framework 层的 `IMms` 接口 |

#### 10.1.4 SmsManager 到 MmsService 的跨进程调用

在平台 API 路径下，调用链为：

```
SmsManager.downloadMultimediaMessage()
  -> IMms.Stub (AIDL 接口)
    -> MmsService (系统服务)
      -> MmsService.downloadMessage()
```

`SmsManager` 通过 AIDL 接口 `IMms` 与系统进程中的 `MmsService` 通信。`MmsService` 收到请求后，将其封装为 `DownloadRequest` 并加入下载队列。

#### 10.1.5 完整调用链汇总

| 步骤 | 层级 | 组件/方法 | 职责 |
|------|------|----------|------|
| 1 | 应用层 | `DownloadMmsAction` | 创建下载任务，发起 Action |
| 2 | 应用层 | `MmsUtils.downloadMmsMessage()` | 前置检查，构造 extras 参数 |
| 3 | 应用层 | `MmsSender.downloadMms()` | 创建临时文件 URI、构造 PendingIntent |
| 4 | 兼容库层 | `MmsManager.downloadMultimediaMessage()` | 根据 API 能力选择路径 |
| 5a | 兼容库层 (Legacy) | `MmsService.startRequest(DownloadRequest)` | 应用进程内直接执行 |
| 5b | 框架层 (平台 API) | `SmsManager.downloadMultimediaMessage()` | 跨进程调用入口 |
| 6 | 框架层 | `IMms` AIDL 接口 | Binder 跨进程传输 |
| 7 | 系统服务层 | `MmsService.downloadMessage()` | 系统服务接收并排队 |
| 8 | 系统服务层 | `DownloadRequest.doHttp()` | 获取 HttpClient，发起 HTTP 请求 |
| 9 | 系统服务层 | `MmsHttpClient.execute(METHOD_GET)` | HTTP GET 请求 MMSC |
| 10 | 系统服务层 | `DownloadRequest.persistIfRequired()` | PDU 解析与数据库持久化 |
| 11 | 系统服务层 | `MmsRequest.processResult()` | PendingIntent 回调应用 |
| 12 | 应用层 | `SendStatusReceiver` | 接收下载结果广播 |
| 13 | 应用层 | `ProcessDownloadedMmsAction` | 处理下载结果，更新 UI |

---

### 10.2 MmsHttpClient.execute() HTTP GET 请求

`MmsHttpClient` 是彩信下载的核心网络通信组件，负责通过 HTTP 协议与 MMSC 服务器交互。对于下载操作，使用 **HTTP GET** 方法（无 POST body）。

#### 10.2.1 构造函数 -- 绕过私有 DNS

```java
// MmsHttpClient.java
public MmsHttpClient(Context context, Network network,
        ConnectivityManager connectivityManager) {
    mContext = context;
    // MMSC 位于运营商私有网络上，可能无法通过第三方私有 DNS 解析
    mNetwork = network.getPrivateDnsBypassingCopy();
    mConnectivityManager = connectivityManager;
}
```

关键设计：`network.getPrivateDnsBypassingCopy()` 创建了一个绕过私有 DNS 的网络副本。这是因为 MMSC 通常位于运营商内网，使用第三方私有 DNS（如 dns.google）可能导致无法解析 MMSC 域名。

#### 10.2.2 代理设置

```java
Proxy proxy = Proxy.NO_PROXY;
if (isProxySet) {
    proxy = new Proxy(Proxy.Type.HTTP,
            new InetSocketAddress(mNetwork.getByName(proxyHost), proxyPort));
}
```

若 APN 配置了 MMS 代理，则创建 `Proxy.Type.HTTP` 类型的代理，并通过 `mNetwork.getByName()` 在指定网络上进行 DNS 解析。

#### 10.2.3 绑定网络打开连接

```java
connection = (HttpURLConnection) mNetwork.openConnection(url, proxy);
```

使用 `Network.openConnection()` 而非全局 `URL.openConnection()`，确保 HTTP 请求走指定的移动数据网络，而非默认网络（如 Wi-Fi）。这是 MMS 通信的关键：MMSC 流量必须通过运营商指定的网络承载。

#### 10.2.4 超时设置

```java
connection.setConnectTimeout(
        mmsConfig.getInt(SmsManager.MMS_CONFIG_HTTP_SOCKET_TIMEOUT));
connection.setReadTimeout(
        mmsConfig.getInt(SmsManager.MMS_CONFIG_HTTP_SOCKET_TIMEOUT));
```

连接超时和读取超时均取自 `MMS_CONFIG_HTTP_SOCKET_TIMEOUT` 配置项（通常为运营商通过 CarrierConfig 设置，常见值为 30 秒）。

#### 10.2.5 HTTP 通用头

MmsHttpClient 在所有请求中添加以下标准头：

```java
// Accept: 支持多种 MIME 类型
connection.setRequestProperty(HEADER_ACCEPT, HEADER_VALUE_ACCEPT);
// HEADER_VALUE_ACCEPT = "*/*, application/vnd.wap.mms-message, application/vnd.wap.sic"

// Accept-Language: 基于当前 Locale
connection.setRequestProperty(
        HEADER_ACCEPT_LANGUAGE, getCurrentAcceptLanguage(Locale.getDefault()));

// User-Agent: 来自 CarrierConfig
final String userAgent = mmsConfig.getString(SmsManager.MMS_CONFIG_USER_AGENT);
connection.setRequestProperty(HEADER_USER_AGENT, userAgent);
```

#### 10.2.6 x-wap-profile 头

```java
String uaProfUrlTagName =
        mmsConfig.getString(SmsManager.MMS_CONFIG_UA_PROF_TAG_NAME);
final String uaProfUrl = mmsConfig.getString(SmsManager.MMS_CONFIG_UA_PROF_URL);

if (!TextUtils.isEmpty(uaProfUrl)) {
    if (TextUtils.isEmpty(uaProfUrlTagName)) {
        uaProfUrlTagName = UA_PROF_TAG_NAME_DEFAULT; // "x-wap-profile"
    }
    connection.setRequestProperty(uaProfUrlTagName, uaProfUrl);
}
```

UA Profile URL 是设备能力的描述文件地址，以 `x-wap-profile`（默认）或运营商自定义的 HTTP 头名称发送，供 MMSC 判断设备支持的媒体类型和尺寸。

#### 10.2.7 可选 Connection: close 头

```java
if (mmsConfig.getBoolean(CarrierConfigManager.KEY_MMS_CLOSE_CONNECTION_BOOL, false)) {
    connection.setRequestProperty(HEADER_CONNECTION, HEADER_CONNECTION_CLOSE);
}
```

部分运营商要求每次 MMS 请求/响应完成后立即关闭 TCP 连接（禁用 Keep-Alive），通过 `KEY_MMS_CLOSE_CONNECTION_BOOL` 配置控制。参考 RFC 7230 Section 6.6。

#### 10.2.8 运营商自定义 HTTP 头

```java
addExtraHeaders(connection, mmsConfig, subId);
```

`addExtraHeaders()` 解析 `MMS_CONFIG_HTTP_PARAMS` 配置项中的自定义头，支持宏替换：

```java
// MmsHttpClient.java
private void addExtraHeaders(HttpURLConnection connection, Bundle mmsConfig, int subId) {
    final String extraHttpParams = mmsConfig.getString(SmsManager.MMS_CONFIG_HTTP_PARAMS);
    if (!TextUtils.isEmpty(extraHttpParams)) {
        String paramList[] = extraHttpParams.split("\\|");
        for (String paramPair : paramList) {
            String splitPair[] = paramPair.split(":", 2);
            if (splitPair.length == 2) {
                final String name = splitPair[0].trim();
                final String value = resolveMacro(mContext, splitPair[1].trim(), mmsConfig, subId);
                if (!TextUtils.isEmpty(name) && !TextUtils.isEmpty(value)) {
                    connection.setRequestProperty(name, value);
                }
            }
        }
    }
}
```

HTTP params 配置格式为 `HeaderName1:Value1|HeaderName2:Value2`，以竖线 `|` 分隔多对头，冒号 `:` 分隔名称和值。

支持的宏定义（`##MACRO##` 格式）：

| 宏 | 含义 | 来源 |
|----|------|------|
| `##LINE1##` | 完整电话号码（含国家码） | `TelephonyManager.getLine1Number()` |
| `##LINE1NOCOUNTRYCODE##` | 不含国家码的电话号码 | `PhoneUtils.getNationalNumber()` |
| `##NAI##` | 网络接入标识符（Base64 编码） | `TelephonyManager.getNai()` + NAI 后缀 |

宏解析逻辑通过正则 `##(\S+)##` 匹配，并调用 `getMacroValue()` 进行替换：

```java
// MmsHttpClient.java
private static final Pattern MACRO_P = Pattern.compile("##(\\S+)##");

public static String getMacroValue(Context context, String macro, Bundle mmsConfig, int subId) {
    final TelephonyManager telephonyManager = ((TelephonyManager)
            context.getSystemService(Context.TELEPHONY_SERVICE))
            .createForSubscriptionId(subId);
    if (MACRO_LINE1.equals(macro)) {
        return getPhoneNumberForMacroLine1(telephonyManager, context, subId);
    } else if (MACRO_LINE1NOCOUNTRYCODE.equals(macro)) {
        return PhoneUtils.getNationalNumber(telephonyManager,
                getPhoneNumberForMacroLine1(telephonyManager, context, subId));
    } else if (MACRO_NAI.equals(macro)) {
        return getNai(telephonyManager, mmsConfig);
    }
    return null;
}
```

`##NAI##` 宏的特殊处理：获取到 NAI 后追加 `MMS_CONFIG_NAI_SUFFIX` 配置的后缀，然后进行 Base64 编码，主要用于 Sprint 等运营商的身份认证。

#### 10.2.9 GET 请求执行

```java
} else if (METHOD_GET.equals(method)) {
    if (LogUtil.isLoggable(Log.VERBOSE)) {
        logHttpHeaders(connection.getRequestProperties(), requestId);
    }
    connection.setRequestMethod(METHOD_GET);
}
```

对于下载操作，HTTP 方法为 `GET`，不携带 POST body，不设置 `Content-Type` 头。消息的下载地址（contentLocation）已编码在 URL 中。

#### 10.2.10 响应码检查与响应体读取

```java
final int responseCode = connection.getResponseCode();
if (responseCode / 100 != 2) {
    throw new MmsHttpException(responseCode, responseMessage);
}
final InputStream in = new BufferedInputStream(connection.getInputStream());
final ByteArrayOutputStream byteOut = new ByteArrayOutputStream();
final byte[] buf = new byte[4096];
int count = 0;
while ((count = in.read(buf)) > 0) {
    byteOut.write(buf, 0, count);
}
in.close();
return byteOut.toByteArray();
```

关键处理：
1. **响应码检查**：仅接受 2xx 状态码，非 2xx 抛出 `MmsHttpException`
2. **响应体读取**：使用 `BufferedInputStream` + `ByteArrayOutputStream`，4KB 缓冲区，一次性读入内存
3. **连接关闭**：在 `finally` 块中调用 `connection.disconnect()`，确保无论成功失败都释放连接

---

### 10.3 IPv4 等待机制（maybeWaitForIpv4）

#### 10.3.1 触发条件

在执行 HTTP 请求前，`MmsHttpClient` 会调用 `maybeWaitForIpv4()` 检查网络可达性：

```java
// MmsHttpClient.java
maybeWaitForIpv4(requestId, url);
```

#### 10.3.2 实现逻辑

```java
private static final int IPV4_WAIT_ATTEMPTS = 15;
private static final long IPV4_WAIT_DELAY_MS = 1000; // 1 秒

private void maybeWaitForIpv4(final String requestId, final URL url) {
    // 如果是 IPv4 字面地址且在 IPv6-only 网络上，等待 IPv4 可用
    Inet4Address ipv4Literal = null;
    try {
        ipv4Literal = (Inet4Address) InetAddress.parseNumericAddress(url.getHost());
    } catch (IllegalArgumentException | ClassCastException e) {
        // Ignore
    }
    if (ipv4Literal == null) {
        // 不是 IPv4 地址，直接返回
        return;
    }
    for (int i = 0; i < IPV4_WAIT_ATTEMPTS; i++) {
        final LinkProperties lp = mConnectivityManager.getLinkProperties(mNetwork);
        if (lp != null) {
            if (!lp.isReachable(ipv4Literal)) {
                LogUtil.w(requestId, "HTTP: IPv4 not yet provisioned");
                try {
                    Thread.sleep(IPV4_WAIT_DELAY_MS);
                } catch (InterruptedException e) {
                    // Ignore
                }
            } else {
                LogUtil.i(requestId, "HTTP: IPv4 provisioned");
                break;
            }
        } else {
            LogUtil.w(requestId, "HTTP: network disconnected, skip ipv4 check");
            break;
        }
    }
}
```

#### 10.3.3 机制详解

| 参数 | 值 | 说明 |
|------|----|------|
| `IPV4_WAIT_ATTEMPTS` | 15 | 最大等待次数 |
| `IPV4_WAIT_DELAY_MS` | 1000 | 每次等待间隔（毫秒） |
| 最大等待时间 | 15 秒 | 15 x 1 秒 |

工作流程：
1. **地址检测**：尝试将 URL 的 host 解析为 `Inet4Address` 字面值。如果 URL host 是域名或 IPv6 地址，`parseNumericAddress` 将抛出异常，直接跳过等待
2. **可达性检查**：对于 IPv4 字面值地址，通过 `LinkProperties.isReachable()` 检查该地址是否在当前网络可达
3. **轮询等待**：若不可达，每次 sleep 1 秒后重试，最多等待 15 秒
4. **提前退出**：若网络断开（`lp == null`）则直接跳出

**应用场景**：在 IPv6-only 网络环境下，设备通过 464XLAT 或 DS-Lite 等隧道技术获取 IPv4 连接。MMSC 地址可能是纯 IPv4 字面值（如 `http://10.0.0.1/mms/wapenc`），此时需要等待 NAT64 隧道就绪后方可建立连接。

---

### 10.4 DownloadRequest.persistIfRequired() 持久化

HTTP 下载成功后，`MmsRequest` 的执行流程进入 `processResult()`，其中第一步就是调用 `persistIfRequired()` 尝试将下载到的 PDU 数据持久化到 telephony provider 的 Mms Inbox。

#### 10.4.1 完整代码

```java
// DownloadRequest.java
@Override
protected Uri persistIfRequired(Context context, int result, byte[] response) {
    final String requestId = getRequestId();
    // 通知其他用户空间的 MMS 应用有新消息下载完成
    notifyOfDownload(context);

    if (!mRequestManager.getAutoPersistingPref()) {
        return null;
    }
    LogUtil.d(requestId, "persistIfRequired. "
            + MmsService.formatCrossStackMessageId(mMessageId));
    if (response == null || response.length < 1) {
        LogUtil.e(requestId, "persistIfRequired: empty response. "
                + MmsService.formatCrossStackMessageId(mMessageId));
        return null;
    }
    final long identity = Binder.clearCallingIdentity();
    try {
        final boolean supportMmsContentDisposition =
                mMmsConfig.getBoolean(SmsManager.MMS_CONFIG_SUPPORT_MMS_CONTENT_DISPOSITION);
        // 解析 RetrieveConf PDU
        final GenericPdu pdu = (new PduParser(response, supportMmsContentDisposition)).parse();
        if (pdu == null || !(pdu instanceof RetrieveConf)) {
            LogUtil.e(requestId, "persistIfRequired: invalid parsed PDU. "
                    + MmsService.formatCrossStackMessageId(mMessageId));
            return null;
        }
        final RetrieveConf retrieveConf = (RetrieveConf) pdu;
        final int status = retrieveConf.getRetrieveStatus();
        if (status != PduHeaders.RETRIEVE_STATUS_OK) {
            LogUtil.e(requestId, "persistIfRequired: retrieve failed " + status
                    + ", " + MmsService.formatCrossStackMessageId(mMessageId));
            // 更新 NotificationInd 的 retrieve status
            final ContentValues values = new ContentValues(1);
            values.put(Telephony.Mms.RETRIEVE_STATUS, status);
            SqliteWrapper.update(context, context.getContentResolver(),
                    Telephony.Mms.CONTENT_URI, values,
                    LOCATION_SELECTION,
                    new String[] {
                            Integer.toString(PduHeaders.MESSAGE_TYPE_NOTIFICATION_IND),
                            mLocationUrl
                    });
            return null;
        }
        // 持久化到 Mms Inbox
        final PduPersister persister = PduPersister.getPduPersister(context);
        final Uri messageUri = persister.persist(
                pdu, Telephony.Mms.Inbox.CONTENT_URI,
                true/*createThreadId*/, true/*groupMmsEnabled*/,
                null/*preOpenedFiles*/);
        if (messageUri == null) {
            LogUtil.e(requestId, "persistIfRequired: can not persist message. "
                    + MmsService.formatCrossStackMessageId(mMessageId));
            return null;
        }
        // 更新消息属性
        final ContentValues values = new ContentValues();
        values.put(Telephony.Mms.DATE, System.currentTimeMillis() / 1000L);
        values.put(Telephony.Mms.READ, 0);
        values.put(Telephony.Mms.SEEN, 0);
        if (!TextUtils.isEmpty(mCreator)) {
            values.put(Telephony.Mms.CREATOR, mCreator);
        }
        values.put(Telephony.Mms.SUBSCRIPTION_ID, mSubId);
        if (SqliteWrapper.update(context, context.getContentResolver(),
                messageUri, values, null/*where*/, null/*selectionArg*/) != 1) {
            LogUtil.e(requestId, "persistIfRequired: can not update message. "
                    + MmsService.formatCrossStackMessageId(mMessageId));
        }
        // 删除对应的 NotificationInd 记录
        SqliteWrapper.delete(context, context.getContentResolver(),
                Telephony.Mms.CONTENT_URI, LOCATION_SELECTION,
                new String[]{
                        Integer.toString(PduHeaders.MESSAGE_TYPE_NOTIFICATION_IND),
                        mLocationUrl
                });
        return messageUri;
    } catch (MmsException e) {
        // ...
    } catch (SQLiteException e) {
        // ...
    } catch (RuntimeException e) {
        // ...
    } finally {
        Binder.restoreCallingIdentity(identity);
    }
    return null;
}
```

#### 10.4.2 关键步骤解析

**第一步：notifyOfDownload() 广播通知**

```java
// DownloadRequest.java
private void notifyOfDownload(Context context) {
    final Intent intent = new Intent(Telephony.Sms.Intents.MMS_DOWNLOADED_ACTION);
    intent.addFlags(Intent.FLAG_RECEIVER_NO_ABORT);
    // 向所有运行中的用户发送广播
    int[] users = ActivityManager.getService().getRunningUserIds();
    for (int i = users.length - 1; i >= 0; i--) {
        UserHandle targetUser = new UserHandle(users[i]);
        // 根据 user policy 过滤可接收的用户
        context.sendBroadcastAsUser(intent, targetUser);
    }
}
```

在持久化之前，先发送 `MMS_DOWNLOADED_ACTION` 广播，通知多用户环境下的其他 MMS 应用有新消息已下载。这对于工作 profile 等多用户场景至关重要。

**第二步：autoPersistingPref 检查**

`mRequestManager.getAutoPersistingPref()` 判断是否启用自动持久化。若为 false，表示调用应用希望自行处理 PDU 数据（直接写入 contentUri），此时直接返回 null。

**第三步：PDU 解析**

```java
final GenericPdu pdu = (new PduParser(response, supportMmsContentDisposition)).parse();
if (pdu == null || !(pdu instanceof RetrieveConf)) {
    return null; // 无效 PDU
}
```

使用 `PduParser` 解析响应字节。下载操作的预期响应类型是 `RetrieveConf`（M-Retrieve.conf）。`supportMmsContentDisposition` 控制是否支持 Content-Disposition 头的解析。

**第四步：RetrieveStatus 检查**

```java
final int status = retrieveConf.getRetrieveStatus();
if (status != PduHeaders.RETRIEVE_STATUS_OK) {
    // 更新 NotificationInd 的 RETRIEVE_STATUS 字段
    return null;
}
```

若 MMSC 返回的 RetrieveConf 中 `RetrieveStatus` 不为 `RETRIEVE_STATUS_OK`，说明检索失败。此时不持久化消息，但更新原始 NotificationInd 记录的 retrieve status 字段，以便应用层感知失败原因。

**第五步：PduPersister.persist() 存储**

```java
final Uri messageUri = persister.persist(
        pdu, Telephony.Mms.Inbox.CONTENT_URI,
        true/*createThreadId*/, true/*groupMmsEnabled*/,
        null/*preOpenedFiles*/);
```

将 `RetrieveConf` PDU 存储到 telephony provider 的 `Mms Inbox` 表。`createThreadId=true` 表示自动创建会话线程。`groupMmsEnabled=true` 启用群组彩信支持。返回的 `messageUri` 形如 `content://mms/inbox/123`。

**第六步：更新 DATE/READ 属性**

```java
values.put(Telephony.Mms.DATE, System.currentTimeMillis() / 1000L);
values.put(Telephony.Mms.READ, 0);
values.put(Telephony.Mms.SEEN, 0);
values.put(Telephony.Mms.SUBSCRIPTION_ID, mSubId);
```

设置消息的接收时间戳、未读状态和订阅 ID。

**第七步：删除 NotificationInd**

```java
SqliteWrapper.delete(context, context.getContentResolver(),
        Telephony.Mms.CONTENT_URI, LOCATION_SELECTION,
        new String[]{
                Integer.toString(PduHeaders.MESSAGE_TYPE_NOTIFICATION_IND),
                mLocationUrl
        });
```

消息持久化成功后，删除原始的 `M-Notification.ind` 记录，避免重复通知。

---

### 10.5 processResult() 结果处理

`MmsRequest.processResult()` 是所有 MMS 请求（发送和下载）的结果统一处理入口。

#### 10.5.1 完整代码

```java
// MmsRequest.java
private void processResult(Context context, int result, byte[] response, int httpStatusCode,
        boolean handledByCarrierApp, int retryId) {
    final Uri messageUri = persistIfRequired(context, result, response);

    final String requestId = this.getRequestId();
    currentState = result == Activity.RESULT_OK ? MmsRequestState.Success
            : MmsRequestState.Failure;

    // 通过 PendingIntent 返回 MMS HTTP 请求结果
    final PendingIntent pendingIntent = getPendingIntent();
    if (pendingIntent != null) {
        boolean succeeded = true;
        Intent fillIn = new Intent();
        if (response != null) {
            succeeded = transferResponse(fillIn, response);
        }
        if (messageUri != null) {
            fillIn.putExtra("uri", messageUri.toString());
        }
        if (result == SmsManager.MMS_ERROR_HTTP_FAILURE && httpStatusCode != 0) {
            fillIn.putExtra(SmsManager.EXTRA_MMS_HTTP_STATUS, httpStatusCode);
        }
        fillIn.putExtra(EXTRA_LAST_CONNECTION_FAILURE_CAUSE_CODE, mLastConnectionFailure);
        fillIn.putExtra(EXTRA_HANDLED_BY_CARRIER_APP, handledByCarrierApp);
        try {
            if (!succeeded) {
                result = SmsManager.MMS_ERROR_IO_ERROR;
            }
            reportPossibleAnomaly(result, httpStatusCode);
            pendingIntent.send(context, result, fillIn);
            mMmsStats.addAtomToStorage(result, retryId, handledByCarrierApp, mMessageId,
                    getPduLength(result, response), httpStatusCode);
        } catch (PendingIntent.CanceledException e) {
            LogUtil.e(requestId, "Sending pending intent canceled", e);
        }
    }

    revokeUriPermission(context);
}
```

#### 10.5.2 核心处理流程

1. **调用 persistIfRequired()**：首先尝试将下载到的 PDU 持久化到数据库，返回 `messageUri`（成功时为 `content://mms/inbox/XXX`，失败时为 null）

2. **transferResponse() 写入 contentUri**：对于 `DownloadRequest`，`transferResponse()` 将响应 PDU 字节写入应用提供的 `contentUri`（临时文件）：
   ```java
   // DownloadRequest.java
   @Override
   protected boolean transferResponse(Intent fillIn, final byte[] response) {
       return mRequestManager.writePduToContentUri(mContentUri, response, mCallingUser);
   }
   ```

3. **PendingIntent.send() 回调应用**：将结果通过 `PendingIntent` 发送回 Messaging 应用。Intent 中携带的 extras：

   | Extra | 含义 |
   |-------|------|
   | `uri` | 持久化后的消息 URI（成功时） |
   | `EXTRA_MMS_HTTP_STATUS` | HTTP 错误码（HTTP 失败时） |
   | `EXTRA_LAST_CONNECTION_FAILURE_CAUSE_CODE` | 数据连接最后的失败原因码 |
   | `EXTRA_HANDLED_BY_CARRIER_APP` | 是否由运营商应用处理 |

4. **成功与失败的不同路径**：
   - **成功**（`result == RESULT_OK`）：状态设为 `MmsRequestState.Success`，`messageUri` 不为 null，Intent 中携带持久化 URI
   - **HTTP 失败**（`result == MMS_ERROR_HTTP_FAILURE`）：额外携带 HTTP 状态码，应用层据此判断是否重试（如 404 不重试，其他自动重试）
   - **IO 失败**（`transferResponse` 写入失败）：`result` 被改为 `MMS_ERROR_IO_ERROR`
   - **异常上报**：调用 `reportPossibleAnomaly()` 对特定错误进行异常记录

---

### 10.6 ProcessDownloadedMmsAction 处理下载结果

Messaging 应用收到 PendingIntent 回调后，`SendStatusReceiver` 触发 `ProcessDownloadedMmsAction`，在后台线程中完成下载结果的最终处理。

#### 10.6.1 入口调用

```java
// ProcessDownloadedMmsAction.java
public static void processMessageDownloaded(final int resultCode, final Bundle extras) {
    final ProcessDownloadedMmsAction action = new ProcessDownloadedMmsAction();
    final Bundle params = action.actionParameters;
    params.putBoolean(KEY_DOWNLOADED_BY_PLATFORM, true);
    params.putString(KEY_MESSAGE_ID, messageId);
    params.putInt(KEY_RESULT_CODE, resultCode);
    params.putInt(KEY_HTTP_STATUS_CODE,
            extras.getInt(SmsManager.EXTRA_MMS_HTTP_STATUS, 0));
    params.putParcelable(KEY_CONTENT_URI, contentUri);
    // ... 其他参数
    action.start();
}
```

#### 10.6.2 后台处理（doBackgroundWork）

`ProcessDownloadedMmsAction` 使用 Action 框架的 `requestBackgroundWork()` 在后台线程执行核心逻辑：

**成功路径（resultCode == RESULT_OK）**：

1. **读取下载文件**：从 `contentUri`（临时文件）中读取 PDU 字节
   ```java
   byte[] downloadedData = Files.toByteArray(downloadedFile);
   ```

2. **解析 RetrieveConf**：
   ```java
   final RetrieveConf retrieveConf = MmsSender.parseRetrieveConf(downloadedData, subId);
   ```

3. **插入 telephony provider 并发送响应**：
   ```java
   final MmsUtils.StatusPlusUri result =
           MmsUtils.insertDownloadedMessageAndSendResponse(context,
                   notificationUri, subId, subPhoneNumber, transactionId,
                   contentLocation, autoDownload, receivedTimestampInSeconds,
                   expiry, retrieveConf);
   ```

4. **删除临时文件**

**失败路径（resultCode != RESULT_OK）**：
```java
final int httpStatusCode = actionParameters.getInt(KEY_HTTP_STATUS_CODE);
status = MmsSender.getErrorResultStatus(resultCode, httpStatusCode);
```

错误状态映射：

| resultCode | httpStatusCode | 返回值 | 含义 |
|------------|---------------|--------|------|
| `MMS_ERROR_UNABLE_CONNECT_MMS` | - | `MMS_REQUEST_AUTO_RETRY` | 网络连接失败，自动重试 |
| `MMS_ERROR_IO_ERROR` | - | `MMS_REQUEST_AUTO_RETRY` | IO 错误，自动重试 |
| `MMS_ERROR_HTTP_FAILURE` | 404 | `MMS_REQUEST_NO_RETRY` | 资源不存在，不重试 |
| `MMS_ERROR_HTTP_FAILURE` | 非404 | `MMS_REQUEST_AUTO_RETRY` | HTTP 错误，自动重试 |
| `MMS_ERROR_INVALID_APN` | - | `MMS_REQUEST_MANUAL_RETRY` | APN 配置无效，需手动重试 |
| `MMS_ERROR_NO_DATA_NETWORK` | - | `MMS_REQUEST_MANUAL_RETRY` | 无数据网络，需手动重试 |

#### 10.6.3 前台处理（processBackgroundResponse）

后台工作完成后，回到主线程执行 UI 更新：

**成功时的处理流程**：

1. **删除 NotificationInd**：
   ```java
   SqliteWrapper.delete(context, context.getContentResolver(),
           mmsNotificationUri, null, null);
   ```

2. **加载持久化的 MMS 消息**：
   ```java
   mms = MmsUtils.loadMms(mmsUri);
   ```

3. **获取/创建参与者和会话**：
   ```java
   final ParticipantData sender = ParticipantData.getFromRawPhoneBySimLocale(from, subId);
   final String senderParticipantId =
           BugleDatabaseOperations.getOrCreateParticipantInTransaction(db, sender);
   conversationId = BugleDatabaseOperations.getOrCreateConversationFromThreadId(db,
           mms.mThreadId, blockedSender, subId);
   ```

4. **更新消息状态为 INCOMING_COMPLETE**：
   ```java
   message = MmsUtils.createMmsMessage(mms, conversationId, senderParticipantId,
           selfId, MessageData.BUGLE_STATUS_INCOMING_COMPLETE);
   ```

5. **更新 Bugle 数据库**：插入或更新消息记录，处理群组会话迁移

6. **通知 UI 刷新**：
   ```java
   BugleNotifications.update(false/*silent*/, conversationId, BugleNotifications.UPDATE_ALL);
   MessagingContentProvider.notifyMessagesChanged(conversationId);
   ```

**失败时的处理流程**：

1. **更新消息状态**：
   ```java
   int bugleStatus = statusIfFailed;
   if (status == MmsUtils.MMS_REQUEST_MANUAL_RETRY) {
       bugleStatus = MessageData.BUGLE_STATUS_INCOMING_DOWNLOAD_FAILED;
   } else if (status == MmsUtils.MMS_REQUEST_NO_RETRY) {
       bugleStatus = MessageData.BUGLE_STATUS_INCOMING_EXPIRED_OR_NOT_AVAILABLE;
   }
   DownloadMmsAction.updateMessageStatus(mmsNotificationUri, messageId,
           notificationConversationId, bugleStatus, rawStatus);
   ```

2. **显示错误通知**

#### 10.6.4 自动下载失败 -- DEFERRED 响应

当自动下载失败且需要手动重试时，`ProcessDownloadedMmsAction` 会异步发送 DEFERRED 响应：

```java
// processBackgroundResponse 中
final boolean needToSendDeferredResp =
        autoDownload && (status == MmsUtils.MMS_REQUEST_MANUAL_RETRY);
if (needToSendDeferredResp) {
    sendDeferredRespStatus(messageId, transactionId, contentLocation, subId);
}
```

`sendDeferredRespStatus()` 发送 `PduHeaders.STATUS_DEFERRED` 状态的 NotifyRespInd，告知 MMSC "暂时无法下载，稍后手动重试"。

---

### 10.7 NotifyRespInd 确认发送

MMSC 发送 `M-Notification.ind` 后，期望收到来自终端的 `M-NotifyResp.ind` 确认消息，告知消息的检索状态。

#### 10.7.1 确认状态类型

| 状态 | 常量 | 场景 |
|------|------|------|
| `STATUS_RETRIEVED` | 0x80 | 自动下载成功，消息已被检索 |
| `STATUS_DEFERRED` | 0x81 | 自动下载失败，稍后手动检索 |
| `STATUS_REJECTED` | 0x82 | 用户拒绝接收 |

#### 10.7.2 sendNotifyResponseForMmsDownload() 调用链

**自动下载成功时**（`MmsUtils.insertDownloadedMessageAndSendResponse()` 中）：

```java
// MmsUtils.java
if (autoDownload) {
    sendNotifyResponseForMmsDownload(context, subId,
            notificationTransactionId, contentLocation,
            PduHeaders.STATUS_RETRIEVED);
} else {
    sendAcknowledgeForMmsDownload(context, subId,
            retrieveConf.getTransactionId(), contentLocation);
}
```

- **自动下载**：发送 `STATUS_RETRIEVED` 的 `M-NotifyResp.ind`
- **手动下载**：发送 `M-Acknowledge.ind`（AcknowledgeInd），使用 `RetrieveConf` 中的 `transactionId`

**自动下载失败时**（`ProcessDownloadedMmsAction` 中）：

```java
// ProcessDownloadedMmsAction.java (doBackgroundWork)
MmsUtils.sendNotifyResponseForMmsDownload(context, subId,
        MmsUtils.stringToBytes(transactionId, "UTF-8"),
        contentLocation, PduHeaders.STATUS_DEFERRED);
```

#### 10.7.3 NotifyRespInd 构造与发送

`MmsSender.sendNotifyResponseForMmsDownload()` 创建 `NotifyRespInd` PDU 并通过 MMS 发送通道提交：

```java
// MmsSender.java
public static void sendNotifyResponseForMmsDownload(final Context context, final int subId,
        final byte[] transactionId, final String contentLocation, final int status)
        throws MmsFailureException, InvalidHeaderValueException {
    // 创建 M-NotifyResp.ind PDU
    final NotifyRespInd notifyRespInd = new NotifyRespInd(
            PduHeaders.CURRENT_MMS_VERSION, transactionId, status);
    final Uri messageUri = Uri.parse(contentLocation);
    // 打包并通过 MMS 发送通道提交
    sendMms(context, subId, messageUri,
            MmsConfig.get(subId).getNotifyWapMMSC() ? contentLocation : null,
            notifyRespInd,
            false /* responseImportant */,
            null /* sentIntentExtras */);
}
```

`getNotifyWapMMSC()` 决定确认消息的目标地址：若为 true，则使用 contentLocation URL（WAP 方式发送到 MMSC）；若为 false，则使用 APN 配置的默认 MMSC 地址。

#### 10.7.4 MmsUtils 封装层

`MmsUtils.sendNotifyResponseForMmsDownload()` 是更高层的封装，添加了前置检查：

```java
// MmsUtils.java
public static void sendNotifyResponseForMmsDownload(final Context context, final int subId,
        final byte[] transactionId, final String contentLocation, final int status) {
    try {
        if (contentLocation == null || transactionId == null) {
            return; // 参数不完整，直接返回
        }
        if (!isMmsDataAvailable(subId)) {
            return; // 无数据连接，跳过
        }
        MmsSender.sendNotifyResponseForMmsDownload(
                context, subId, transactionId, contentLocation, status);
    } catch (final MmsFailureException | InvalidHeaderValueException e) {
        // 确认发送失败仅记录日志，不影响主流程
    }
}
```

设计要点：确认消息的发送失败不应阻塞或影响主下载流程。因此所有异常都被捕获并仅记录日志。

---

### 10.8 完整调用链汇总表

以下是从 Modem 收到 WAP Push 通知到 UI 完成更新的 23 步完整链路：

| 步骤 | 层级 | 组件 | 方法/动作 | 说明 |
|------|------|------|-----------|------|
| 1 | RIL/Modem | Modem | 接收 WAP Push | 从空中接口接收 M-Notification.ind |
| 2 | 框架层 | SmsDispatcher | dispatchWapPdu() | 分发 WAP Push 到注册的应用 |
| 3 | 框架层 | WapPushReceiver | onReceive() | 接收 WAP Push 广播 |
| 4 | 应用层 | SmsReceiver | 处理 MMS 类型 WAP Push | 解析 NotificationInd |
| 5 | 应用层 | DownloadMmsAction | start() | 创建下载 Action |
| 6 | 应用层 | MmsUtils | downloadMmsMessage() | 前置检查，构造 extras |
| 7 | 应用层 | MmsSender | downloadMms() | 构造 PendingIntent |
| 8 | 兼容库层 | MmsManager | downloadMultimediaMessage() | 选择 Legacy 或平台 API |
| 9 | 框架层 | SmsManager | downloadMultimediaMessage() | 跨进程调用 |
| 10 | Binder IPC | IMms.Stub | downloadMessage() | AIDL 调用系统服务 |
| 11 | 系统服务层 | MmsService | addToQueue() | 请求入队 |
| 12 | 系统服务层 | DownloadRequest | doHttp() | 获取 HttpClient |
| 13 | 系统服务层 | MmsHttpClient | maybeWaitForIpv4() | IPv4 可达性等待 |
| 14 | 系统服务层 | MmsHttpClient | execute(GET) | HTTP GET 请求 MMSC |
| 15 | 系统服务层 | MMSC 服务器 | 返回 RetrieveConf PDU | 2xx + PDU 响应体 |
| 16 | 系统服务层 | DownloadRequest | persistIfRequired() | PDU 解析 + Inbox 存储 |
| 17 | 系统服务层 | MmsRequest | processResult() | transferResponse + PendingIntent |
| 18 | 应用层 | SendStatusReceiver | onReceive() | 收到 MMS_DOWNLOADED_ACTION |
| 19 | 应用层 | ProcessDownloadedMmsAction | doBackgroundWork() | 读取 PDU，解析消息 |
| 20 | 应用层 | MmsUtils | insertDownloadedMessageAndSendResponse() | 插入 telephony + 发送确认 |
| 21 | 应用层 | MmsSender | sendNotifyResponseForMmsDownload() | 发送 M-NotifyResp.ind |
| 22 | 应用层 | ProcessDownloadedMmsAction | processBackgroundResponse() | 更新 Bugle DB，状态设为 INCOMING_COMPLETE |
| 23 | 应用层 | UI 层 | BugleNotifications + MessagingContentProvider | 通知栏 + 列表刷新 |

---

**小结**：

本章从调用链角度完整剖析了 Android 彩信下载的全流程。`MmsHttpClient` 通过绑定到运营商网络的 HTTP GET 请求获取 RetrieveConf PDU，其中涉及私有 DNS 绕过、IPv4 可达性等待、运营商自定义 HTTP 头等关键机制。下载成功后，`DownloadRequest.persistIfRequired()` 在系统服务层完成 PDU 解析和 telephony provider 持久化，而 `ProcessDownloadedMmsAction` 在应用层完成消息插入、UI 状态更新和通知。最后，`M-NotifyResp.ind` 确认消息确保 MMSC 能够正确跟踪消息的检索状态。


文档完