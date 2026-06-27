---
title: "Android 开机 SIM 卡加载完成全流程分析"
date: "2025-06-27"
summary: "从系统启动到 SIM 卡完全可用（LOADED 状态）的完整流程分析，涵盖 UiccController 初始化、UiccSlot 物理检测、UiccCard 状态机、UiccProfile 运营商信息读取、IccRecords 文件解析与系统广播通知。"
category: "sim-card"
tags: ["UiccController", "UiccSlot", "UiccCard", "UiccProfile", "IccRecords", "SIM", "RIL", "SubscriptionManagerService", "TelephonyRegistry", "IccFileHandler"]
featured: true
---

---

## 第 1 章 概述

### 1.1 SIM 卡加载流程简介

Android 设备开机后，Telephony 框架需要完成一系列复杂的初始化操作才能正常使用 SIM 卡提供的通信服务。SIM 卡加载流程是指从系统启动到 SIM 卡完全可用（`LOADED` 状态）的整个过程，涉及 Framework 层、HAL 层与 Modem 之间的多层交互。

这一流程的核心目标是：
- 检测物理 SIM 卡是否存在
- 与 Modem 建立通信并获取 SIM 卡状态
- 读取 SIM 卡中的运营商信息、联系人、网络选择参数等文件
- 将 SIM 卡状态同步到系统各服务（SubscriptionManagerService、TelephonyRegistry 等）
- 最终广播 SIM 卡就绪状态，供上层应用使用

### 1.2 分层架构设计

Android SIM 卡管理采用深度分层架构，每一层负责不同的抽象维度：

```
┌─────────────────────────────────────────────────────────────┐
│  应用层 (SystemUI/Settings/第三方应用)                        │
│  ─────────────────────────────────────                     │
│  TelephonyManager / SubscriptionManager                     │
├─────────────────────────────────────────────────────────────┤
│  Framework 服务层                                            │
│  ─────────────────────────────────────                     │
│  SubscriptionManagerService / TelephonyRegistry              │
├─────────────────────────────────────────────────────────────┤
│  UICC 核心控制层                                             │
│  ─────────────────────────────────────                     │
│  UiccController → UiccSlot → UiccCard → UiccPort            │
│                          ↓                                  │
│                    UiccProfile                              │
│                          ↓                                  │
│              UiccCardApplication                            │
│                   ↙         ↘                               │
│         IccRecords        IccFileHandler                    │
├─────────────────────────────────────────────────────────────┤
│  RIL / HAL 层                                                │
│  ─────────────────────────────────────                     │
│  RIL.java → RadioSimProxy → IRadioSim (AIDL HAL)            │
│              ↑                                              │
│  SimIndication / SimResponse (IRadioSimIndication/Response) │
├─────────────────────────────────────────────────────────────┤
│  Modem / BP 层                                               │
│  ─────────────────────────────────────                     │
│  基带处理器执行实际 SIM 卡通信 (AT 指令 / QMI / 私有协议)       │
└─────────────────────────────────────────────────────────────┘
```

从物理到逻辑的映射关系：

| 层级 | 代表类 | 职责说明 |
|------|--------|----------|
| 物理卡槽 | `UiccSlot` | 对应设备上的物理 SIM 卡槽，与是否插卡无关 |
| 逻辑卡片 | `UiccCard` | 对应一张物理 SIM 卡或 eSIM，管理多个 Port |
| 卡片端口 | `UiccPort` | MEP 场景下的端口抽象，关联 phoneId |
| 运营商配置 | `UiccProfile` | 运营商 Profile，管理多个 Application |
| 卡应用 | `UiccCardApplication` | USIM/SIM/ISIM 等具体应用 |
| 记录数据 | `IccRecords` / `SIMRecords` | 读取并缓存 SIM 卡中的 EF 文件数据 |
| 文件访问 | `IccFileHandler` | 封装 SIM 卡文件读取接口 |

### 1.3 整体流程总览

正常开机场景下，SIM 卡从初始化到 `LOADED` 状态的核心流程可分为 8 个阶段：

1. **UiccController 初始化**：`PhoneFactory.makeDefaultPhone()` 中创建 `UiccController` 单例，注册 RIL 事件监听
2. **Modem 状态上报**：Modem 通过 `IRadioSimIndication.simStatusChanged()` 主动上报 SIM 状态变化
3. **主动查询状态**：`UiccController` 收到上报后，调用 `getIccCardStatus()` 主动查询详细状态
4. **层级对象创建**：根据查询结果逐级创建/更新 `UiccSlot` → `UiccCard` → `UiccPort` → `UiccProfile`
5. **应用初始化**：`UiccProfile` 创建 `UiccCardApplication`，进而创建 `IccFileHandler` 和 `IccRecords`
6. **状态机推进**：`UiccProfile.updateExternalState()` 将状态更新为 `NOT_READY`，随后进入 `READY`
7. **文件读取**：`SIMRecords.fetchSimRecords()` 发起数十个 EF 文件的异步读取
8. **LOADED 完成**：所有记录加载完成后，状态更新为 `LOADED`，广播 SIM 就绪状态

---

## 第 2 章 关键类与数据结构

### 2.1 UiccController：UICC 全局控制器

`UiccController` 是整个 UICC 体系的入口类，采用单例模式管理。它在 `PhoneFactory.makeDefaultPhone()` 中被创建，负责：

- 持有所有 `UiccSlot` 实例的数组
- 向 RIL 注册 SIM 卡状态变化监听
- 接收 Modem 上报后发起状态查询
- 管理 `mIccChangedRegistrants` 注册表，向订阅者通知 ICC 状态变化
- 广播最终的 SIM 状态（`ACTION_SIM_STATE_CHANGED` 等）

核心事件类型：

| 事件 | 触发条件 |
|------|----------|
| `EVENT_ICC_STATUS_CHANGED` | Modem 上报 SIM 状态发生变化 |
| `EVENT_RADIO_AVAILABLE` | Radio 变为可用状态 |
| `EVENT_RADIO_UNAVAILABLE` | Radio 变为不可用状态，需清空 SIM 信息 |
| `EVENT_SIM_REFRESH` | SIM 刷新通知 |
| `EVENT_GET_ICC_STATUS_DONE` | `getIccCardStatus` 查询完成 |
| `EVENT_SLOT_STATUS_CHANGED` | 卡槽状态变化 |

### 2.2 UiccSlot：物理卡槽抽象

`UiccSlot` 代表设备上的一个物理 SIM 卡槽，与是否插入 SIM 卡无关。主要职责：

- 维护卡槽的物理状态（`SLOT_STATE_INACTIVE` / `SLOT_STATE_ACTIVE`）
- 维护卡状态（`CARDSTATE_ABSENT` / `CARDSTATE_PRESENT` / `CARDSTATE_ERROR` 等）
- 在卡状态变化时创建或更新 `UiccCard`
- 处理卡槽电压相关消息

`update()` 方法是串联 UICC 族类的核心：当卡的新旧状态发生改变时，整套 UICC 对象链都会因 `update()` 的嵌套调用完成刷新。

### 2.3 UiccCard：逻辑 SIM 卡

`UiccCard` 代表一张逻辑上的 SIM 卡（UICC 或 eUICC），职责包括：

- 区分 UICC 卡与 EUICC 卡（eSIM）
- 根据卡类型创建不同的卡对象
- 管理 `UiccPort` 集合（支持 MEP 多端口）
- 维护 `CardState` 和 `CardId`
- 绑定运营商配置文件

### 2.4 UiccPort 与 MEP

`UiccPort` 是较新的抽象，用于支持 MEP（Multiple Enabled Profiles，多启用配置文件）。在单 SIM 场景下，一个 `UiccCard` 通常只有一个 `UiccPort`；在 eSIM MEP 场景下，一个卡可以有多个 Port，每个 Port 关联不同的 `phoneId` 并持有独立的 `UiccProfile`。

### 2.5 UiccProfile：外部状态机核心

`UiccProfile` 是 SIM 卡状态管理的核心类，承担以下职责：

- 管理 `UiccCardApplication` 数组（USIM、SIM、ISIM 等）
- 维护外部可见的 SIM 状态（`UNKNOWN` / `ABSENT` / `PIN_REQUIRED` / `PUK_REQUIRED` / `NETWORK_LOCKED` / `READY` / `LOADED`）
- 通过 `updateExternalState()` 实现状态机决策
- 注册 `EVENT_APP_READY` 和 `EVENT_RECORDS_LOADED` 事件
- 所有应用就绪且记录加载完成后，状态推进到 `LOADED`

### 2.6 UiccCardApplication：SIM 应用状态

`UiccCardApplication` 代表 SIM 卡上的一个具体应用（如 USIM、SIM、CSIM、ISIM），职责包括：

- 维护 `AppState`（`APPSTATE_UNKNOWN` / `APPSTATE_DETECTED` / `APPSTATE_PIN` / `APPSTATE_PUK` / `APPSTATE_SUBSCRIPTION_PERSO` / `APPSTATE_READY`）
- 维护 `PinState`（PIN1/PIN2 的锁定状态）
- 创建对应的 `IccFileHandler` 和 `IccRecords`
- 应用状态变为 `APPSTATE_READY` 时，触发 `notifyReadyRegistrantsIfNeeded()`

### 2.7 IccRecords 与 SIMRecords：SIM 记录读取

`IccRecords` 是抽象基类，定义了 SIM 记录加载的通用机制：

- `mRecordsToLoad` 计数器：跟踪待加载的记录数量
- `onRecordLoaded()`：每个记录加载完成时回调，计数器减一
- `onAllRecordsLoaded()`：所有记录加载完成时回调
- `mRecordsLoadedRegistrants`：注册表，通知订阅者记录已加载

`SIMRecords` 是 `IccRecords` 的具体实现，针对 GSM/USIM 卡：

- `fetchSimRecords()`：发起所有 EF 文件的读取请求
- `onReady()`：应用就绪时触发，调用 `fetchSimRecords()`
- 解析 IMSI、ICCID、SPN、PNN、GID 等关键字段

### 2.8 IccFileHandler：EF 文件访问层

`IccFileHandler` 封装了 SIM 卡 EF（Elementary File）文件的访问接口：

| 方法 | 用途 |
|------|------|
| `loadEFTransparent()` | 读取透明文件（如 EF_ICCID、EF_AD） |
| `loadEFLinearFixed()` | 读取线性定长记录文件的某一条记录 |
| `loadEFLinearFixedAll()` | 读取线性定长记录文件的所有记录 |
| `getEFPath()` | 获取文件的逻辑路径 |

透明文件和线性定长文件是 SIM 卡中最常见的两种文件类型。透明文件是一块连续的数据；线性定长文件由多条等长记录组成。

### 2.9 IccCardStatus：Modem 上报的状态数据结构

`IccCardStatus` 是 Modem 通过 `getIccCardStatusResponse` 返回的数据结构，包含：

- `mCardState`：卡片物理状态（ABSENT / PRESENT / ERROR / RESTRICTED）
- `mUniversalPinState`：通用 PIN 状态
- `mGsmUmtsSubscriptionAppIndex`：GSM/UMTS 应用索引
- `mCdmaSubscriptionAppIndex`：CDMA 应用索引
- `mImsSubscriptionAppIndex`：IMS 应用索引
- `mApplications`：`IccCardApplicationStatus` 数组，描述卡上所有应用的状态
- `mSlotPortMapping`：Slot 与 Port 的映射关系（支持 MEP）

---

## 第 3 章 AIDL HAL 接口与 Modem 交互

### 3.1 IRadioSim 与 IRadioSimIndication 接口概述

Android 从 HIDL HAL 向 AIDL HAL 迁移后，Radio 接口被拆分为多个子接口。与 SIM 卡相关的 AIDL 接口主要包括：

| 接口 | 类型 | 说明 |
|------|------|------|
| `IRadioSim` | HAL 请求接口 | Framework 向 Modem 发起 SIM 相关请求 |
| `IRadioSimResponse` | HAL 响应接口 | Modem 返回请求的处理结果 |
| `IRadioSimIndication` | HAL 指示接口 | Modem 主动向 Framework 上报 SIM 状态变化 |

Framework 侧的对应实现类：

| 类 | 实现接口 | 职责 |
|----|----------|------|
| `SimResponse` | `IRadioSimResponse.Stub` | 处理 Modem 返回的响应，如 `getIccCardStatusResponse` |
| `SimIndication` | `IRadioSimIndication.Stub` | 处理 Modem 主动上报的指示，如 `simStatusChanged` |

### 3.2 SimIndication.simStatusChanged()：Modem 主动上报

当 Modem 检测到 SIM 卡状态发生变化时（如插卡、拔卡、SIM 卡初始化完成、SIM 错误等），会通过 AIDL HAL 主动上报：

```
Modem (BP)
  ↓ AIDL 回调
IRadioSimIndication.simStatusChanged(int indicationType)
  ↓
SimIndication.simStatusChanged()
  ↓
mRil.mIccStatusChangedRegistrants.notifyRegistrants()
  ↓
UiccController.handleMessage(EVENT_ICC_STATUS_CHANGED)
```

`simStatusChanged` 是一个无参数指示（或仅带 `indicationType`），它只通知 Framework "SIM 状态可能变了"，不包含具体的状态信息。因此 Framework 收到后必须发起主动查询。

### 3.3 SimResponse.getIccCardStatusResponse()：查询响应处理

Framework 调用 `IRadioSim.getIccCardStatus()` 后，Modem 通过 `IRadioSimResponse.getIccCardStatusResponse()` 返回详细的 ICC 状态：

```
UiccController
  ↓
mCis[phoneId].getIccCardStatus(Message.obtain(this, EVENT_GET_ICC_STATUS_DONE))
  ↓
RIL.getIccCardStatus()
  ↓
RadioSimProxy.getIccCardStatus(serial)
  ↓ AIDL 调用
Modem 处理
  ↓ AIDL 响应
SimResponse.getIccCardStatusResponse(serial, error, cardStatus)
  ↓
UiccController.handleMessage(EVENT_GET_ICC_STATUS_DONE)
  ↓
onGetIccCardStatusDone(AsyncResult)
```

`CardStatus` 数据结构包含完整的 ICC 卡状态，包括卡状态、应用列表、PIN 状态等。

### 3.4 HAL 接口演进（HIDL → AIDL）

| 维度 | HIDL HAL（Android 8-10） | AIDL HAL（Android 11+） |
|------|--------------------------|-------------------------|
| 接口定义 | `IRadio.hal` / `IRadioIndication.hal` | `IRadioSim.aidl` / `IRadioSimIndication.aidl` |
| 实现语言 | HIDL | AIDL |
| 接口拆分 | 单一 `IRadio` 接口 | 按功能拆分为 `IRadioSim`、`IRadioData`、`IRadioVoice` 等 |
| Framework 类 | `RadioIndication` / `RadioResponse` | `SimIndication` / `SimResponse` / `DataIndication` / `VoiceIndication` 等 |
| 进程通信 | hwbinder | binder |

AIDL HAL 的优势在于接口更细粒度、类型系统与 Java 更一致、跨版本兼容性更好。

### 3.5 RIL 层封装

`RIL.java` 是 Framework 中封装 HAL 调用的关键类。以 `getIccCardStatus` 为例：

```java
// RIL.java
public void getIccCardStatus(Message result) {
    IRadioSimProxy simProxy = getRadioServiceProxy(IRadioSimProxy.class);
    if (simProxy.isEmpty()) return;
    
    RILRequest rr = obtainRequest(RIL_REQUEST_GET_ICC_STATUS, result);
    
    try {
        simProxy.getIccCardStatus(rr.mSerial);
    } catch (RemoteException | RuntimeException e) {
        // 异常处理
    }
}
```

`RadioSimProxy` 是 `IRadioSim` 的代理封装，负责管理 AIDL 服务的绑定和调用。

---

## 第 4 章 初始化流程

### 4.1 PhoneFactory.makeDefaultPhone() 启动 Telephony

Telephony 服务的启动入口是 `PhoneApp`，其 `onCreate()` 调用 `PhoneGlobals.onCreate()`，最终进入 `PhoneFactory.makeDefaultPhone()`：

```
PhoneApp.onCreate()
  ↓
PhoneGlobals.onCreate()
  ↓
PhoneFactory.makeDefaultPhone(context)
  ├── 创建 RIL 实例数组 (sCommandsInterfaces)
  ├── 创建 SubscriptionController
  ├── UiccController.make(context, sCommandsInterfaces)  // ← UICC 初始化入口
  ├── 创建 Phone 实例数组
  ├── 创建 SubscriptionInfoUpdater
  ├── 创建 PhoneSwitcher
  └── 创建 TelephonyNetworkFactory
```

### 4.2 UiccController.make() 单例创建

`UiccController` 通过静态 `make()` 方法创建单例：

```java
public static UiccController make(Context c, CommandsInterface[] ci) {
    synchronized (mLock) {
        if (mInstance != null) {
            throw new RuntimeException("UiccController.make() should only be called once");
        }
        mInstance = new UiccController(c, ci);
        return mInstance;
    }
}
```

构造函数执行以下初始化：

1. **获取卡槽数量**：从配置文件 `config_num_physical_slots` 读取，若小于 phone 数量则使用 phone 数量
2. **创建 UiccSlot 数组**：按物理卡槽数量初始化
3. **初始化 mPhoneIdToSlotId 映射**：默认填充 `INVALID_SLOT_ID`
4. **注册 RadioConfig 监听**：`registerForSimSlotStatusChanged(EVENT_SLOT_STATUS_CHANGED)`
5. **遍历 RIL 注册事件监听**：
   - `registerForIccStatusChanged(EVENT_ICC_STATUS_CHANGED)` — SIM 卡 ICC 状态变化
   - `registerForAvailable(EVENT_RADIO_AVAILABLE)` — Radio 可用
   - `registerForNotAvailable(EVENT_RADIO_UNAVAILABLE)` — Radio 不可用
   - `registerForIccRefresh(EVENT_SIM_REFRESH)` — SIM 刷新
6. **创建 UiccStateChangedLauncher**：用于监听配置变化并广播 SIM 卡状态

### 4.3 注册 RIL 事件监听

`CommandsInterface`（实际实现为 `RIL`）提供了注册机制，允许监听者注册对特定事件的关注：

```java
// UiccController 构造函数中
for (int i = 0; i < mCis.length; i++) {
    mCis[i].registerForIccStatusChanged(this, EVENT_ICC_STATUS_CHANGED, i);
    mCis[i].registerForAvailable(this, EVENT_RADIO_AVAILABLE, i);
    mCis[i].registerForNotAvailable(this, EVENT_RADIO_UNAVAILABLE, i);
    mCis[i].registerForIccRefresh(this, EVENT_SIM_REFRESH, i);
}
```

这里的 `i` 对应 `phoneId`，当事件发生时，`UiccController` 可以通过消息中的 `obj` 知道是哪个 phone/RIL 上报的事件。

### 4.4 多 SIM 场景下的初始化差异

在 DSDS（双卡双待）场景下：

- `mCis` 数组长度为 2，创建两个 RIL 实例
- `mUiccSlots` 数组长度可能大于 2（取决于物理卡槽数量）
- 每个 RIL 独立注册事件监听
- `UiccController` 需要维护 `mPhoneIdToSlotId` 映射关系

在 SSSS（单卡单待）场景下：

- `mCis` 数组长度为 1
- 只有一个 RIL 实例和一个 UiccSlot

---

## 第 5 章 Modem 上报与主动查询

### 5.1 simStatusChanged 上报触发链路

开机后，Modem 完成自身初始化并检测到 SIM 卡存在时，会通过 AIDL HAL 主动上报状态变化：

```
Modem 检测到 SIM 卡状态变化
  ↓ AIDL 异步回调 (binder 线程)
IRadioSimIndication.simStatusChanged(int indicationType)
  ↓
SimIndication.simStatusChanged()
  ↓
mRil.processIndication(indicationType)
  ↓
mRil.mIccStatusChangedRegistrants.notifyRegistrants(
    new AsyncResult(null, null, null))
  ↓
UiccController.handleMessage(EVENT_ICC_STATUS_CHANGED)
```

`SimIndication` 中的实现：

```java
public void simStatusChanged(int indicationType) {
    mRil.processIndication(indicationType);
    if (RIL.RILJ_LOGD) mRil.unslLog("simStatusChanged");
    
    mRil.mIccStatusChangedRegistrants.notifyRegistrants(
        new AsyncResult(null, null, null));
}
```

### 5.2 EVENT_ICC_STATUS_CHANGED 消息处理

`UiccController` 的 Handler 处理 `EVENT_ICC_STATUS_CHANGED`：

```java
case EVENT_ICC_STATUS_CHANGED:
    if (DBG) log("Received EVENT_ICC_STATUS_CHANGED, calling getIccCardStatus");
    mCis[phoneId].getIccCardStatus(
        obtainMessage(EVENT_GET_ICC_STATUS_DONE, phoneId));
    break;
```

处理逻辑非常简单：收到状态变化通知后，立即向对应 RIL 发起 `getIccCardStatus` 查询。

### 5.3 getIccCardStatus() 主动查询

`getIccCardStatus` 的调用链：

```
UiccController
  ↓
CommandsInterface.getIccCardStatus(Message)
  ↓ (实际实现)
RIL.getIccCardStatus(Message)
  ↓
IRadioSim.getIccCardStatus(int serial)
  ↓ AIDL
Modem 处理请求
  ↓
IRadioSimResponse.getIccCardStatusResponse(int serial, 
    RadioError error, CardStatus cardStatus)
```

这个调用是同步发起、异步返回的。Framework 在调用时传入一个 `Message`，响应到达后在 Handler 中处理。

### 5.4 EVENT_GET_ICC_STATUS_DONE 与 onGetIccCardStatusDone()

查询完成后，`UiccController` 收到 `EVENT_GET_ICC_STATUS_DONE`：

```java
case EVENT_GET_ICC_STATUS_DONE:
    AsyncResult ar = (AsyncResult) msg.obj;
    IccCardStatus status = (IccCardStatus) ar.result;
    onGetIccCardStatusDone(status, phoneId);
    break;
```

`onGetIccCardStatusDone()` 是 UICC 对象树创建/更新的核心方法，执行逻辑：

1. **确定 slotId**：根据 `status.mSlotPortMapping` 或默认值确定
2. **更新 phoneId 到 slotId 的映射**
3. **获取或创建 UiccSlot**：
   ```java
   if (mUiccSlots[slotId] == null) {
       mUiccSlots[slotId] = new UiccSlot(mContext, true);
   }
   mUiccSlots[slotId].update(...);
   ```
4. **UiccSlot.update() 触发 UiccCard 创建/更新**：
   - 如果卡状态从 ABSENT 变为 PRESENT，创建新的 `UiccCard`
   - 如果卡状态发生变化，更新现有 `UiccCard`
5. **UiccCard.update() 触发 UiccPort 创建/更新**
6. **UiccPort.update() 触发 UiccProfile 创建/更新**
7. **通知所有 ICC 变化监听者**：
   ```java
   mIccChangedRegistrants.notifyRegistrants(new AsyncResult(null, phoneId, null));
   ```

### 5.5 Slot/Card/Port/Profile 层级创建与更新

`onGetIccCardStatusDone()` 中触发的级联更新：

```
onGetIccCardStatusDone(IccCardStatus, phoneId)
  ↓
mUiccSlots[slotId].update(slotStatus, cardStatus, phoneId)
  ├── 更新卡槽物理状态
  ├── 若卡状态变化且新状态为 PRESENT：
  │   └── mUiccCard = new UiccCard(...)
  └── mUiccCard.update(mContext, mCi, cardStatus)
        ├── 更新 CardState
        ├── 若需要，创建/更新 UiccPort[]
        └── 对每个 UiccPort：
              └── uiccPort.update(cardStatus, isNew)
                    ├── 创建/更新 UiccProfile
                    └── uiccProfile.update(mContext, mCi, cardStatus)
```

`UiccProfile.update()` 的关键操作：

1. 根据 `IccCardStatus.mApplications` 创建 `UiccCardApplication[]`
2. 每个 `UiccCardApplication` 创建时，同时创建 `IccFileHandler` 和 `IccRecords`
3. 注册所有应用的事件监听（`EVENT_APP_READY`、`EVENT_RECORDS_LOADED`）
4. 调用 `updateExternalState()` 更新外部状态为 `NOT_READY`

---

## 第 6 章 UiccProfile 状态机

### 6.1 updateExternalState() 状态决策逻辑

`UiccProfile` 通过 `updateExternalState()` 方法实现状态机决策。该方法在以下时机被调用：

- `UiccProfile.update()` 完成应用创建后
- 收到 `EVENT_APP_READY` 后
- 收到 `EVENT_RECORDS_LOADED` 后
- 收到 `EVENT_CARRIER_PRIVILEGE_RULES_LOADED` 后

状态决策逻辑（简化版）：

```java
private void updateExternalState() {
    if (mUiccCard.getCardState() == CardState.CARDSTATE_ABSENT) {
        setExternalState(IccCardConstants.State.ABSENT);
        return;
    }
    
    if (mUiccCard.getCardState() == CardState.CARDSTATE_ERROR) {
        setExternalState(IccCardConstants.State.CARD_IO_ERROR);
        return;
    }
    
    if (!areAllApplicationsReady()) {
        setExternalState(IccCardConstants.State.NOT_READY);
        return;
    }
    
    if (mPin1Replaced && mPin1State == PinState.PINSTATE_ENABLED_NOT_VERIFIED) {
        setExternalState(IccCardConstants.State.PIN_REQUIRED);
        return;
    }
    
    // 检查是否有应用处于锁定状态
    for (UiccCardApplication app : mUiccApplications) {
        if (app == null) continue;
        AppState appState = app.getState();
        switch (appState) {
            case APPSTATE_PIN:
                setExternalState(IccCardConstants.State.PIN_REQUIRED);
                return;
            case APPSTATE_PUK:
                setExternalState(IccCardConstants.State.PUK_REQUIRED);
                return;
            case APPSTATE_SUBSCRIPTION_PERSO:
                setExternalState(IccCardConstants.State.NETWORK_LOCKED);
                return;
        }
    }
    
    // 所有应用已就绪
    if (!areAllRecordsLoaded() || !areCarrierPrivilegeRulesLoaded()) {
        setExternalState(IccCardConstants.State.READY);
        return;
    }
    
    // 所有条件满足
    setExternalState(IccCardConstants.State.LOADED);
}
```

### 6.2 各状态转换条件

正常开机路径的状态转换：

```
UNKNOWN（初始状态）
  ↓ UiccProfile 创建
NOT_READY（应用未就绪）
  ↓ UiccCardApplication 变为 APPSTATE_READY
READY（应用就绪，记录未加载完成）
  ↓ 所有记录加载完成 + CarrierPrivilegeRules 加载完成
LOADED（完全就绪）
```

异常路径的状态转换：

```
NOT_READY
  ↓ 卡被拔出
ABSENT

NOT_READY / READY
  ↓ 卡出现错误
CARD_IO_ERROR

NOT_READY
  ↓ PIN 未验证
PIN_REQUIRED
  ↓ PIN 验证成功
READY

PIN_REQUIRED
  ↓ PIN 连续输错
PUK_REQUIRED

NOT_READY
  ↓ 网络锁定
NETWORK_LOCKED
```

### 6.3 setExternalState() 状态广播

`setExternalState(State newState)` 负责将状态变化广播出去：

```java
private void setExternalState(State newState) {
    if (newState == mExternalState) return;
    
    mExternalState = newState;
    
    // 设置 SystemProperty
    SystemProperties.set("gsm.sim.state", mExternalState.toString());
    
    // 通知 UiccController
    UiccController.getInstance().updateSimState();
    
    // 解析运营商 ID
    resolveSubscriptionCarrierId();
    
    // 更新运营商服务
    updateCarrierServices();
}
```

### 6.4 SIM 状态广播体系

Android 同时维护三套广播用于向后兼容和新功能：

| 广播 Action | 用途 | 携带信息 |
|------------|------|----------|
| `android.intent.action.SIM_STATE_CHANGED` | 兼容广播，历史遗留 | `ss` 字段包含状态字符串 |
| `android.telephony.action.SIM_CARD_STATE_CHANGED` | 卡片物理状态广播 | `phone` / `slot_index` / `card_state` |
| `android.telephony.action.SIM_APPLICATION_STATE_CHANGED` | 应用状态广播 | `phone` / `slot_index` / `application_state` |

`UiccController.updateSimState()` 负责发送这些广播：

```java
public void updateSimState() {
    for (int i = 0; i < mPhoneIdToSlotId.length; i++) {
        State simState = getSimState(i);
        mTelephonyManager.setSimStateForPhone(i, simState.toString());
        SubscriptionManagerService.getInstance().updateSimState(i, simState);
        
        // 发送兼容广播
        broadcastSimStateChanged(i, simState, reason);
        // 发送 CardState 广播
        broadcastSimCardStateChanged(i, cardState);
        // 发送 ApplicationState 广播
        broadcastSimApplicationStateChanged(i, appState);
    }
}
```

---

## 第 7 章 SIM 文件读取流程

### 7.1 IccRecords.onReady() 触发机制

当 `UiccCardApplication` 状态变为 `APPSTATE_READY` 时：

```
UiccCardApplication 状态变化 → APPSTATE_READY
  ↓
notifyReadyRegistrantsIfNeeded()
  ↓
UiccProfile 收到 EVENT_APP_READY
  ↓
updateExternalState() → 状态变为 READY
  ↓
同时触发：IccRecords.onReady()
```

`IccRecords.onReady()` 在子类 `SIMRecords` 中的实现：

```java
public void onReady() {
    fetchSimRecords();
}
```

### 7.2 SIMRecords.fetchSimRecords() 详解

`fetchSimRecords()` 是 SIM 卡文件读取的入口方法，它会发起大量 EF 文件的读取请求。核心逻辑：

```java
protected void fetchSimRecords() {
    mRecordsRequested = true;
    
    // IMSI 是最高优先级，通过 RIL 直接获取
    mCi.getIMSIForApp(mParentApp.getAid(), obtainMessage(EVENT_GET_IMSI_DONE));
    mRecordsToLoad++;
    
    // 读取 ICCID（卡唯一标识）
    mFh.loadEFTransparent(EF_ICCID, obtainMessage(EVENT_GET_ICCID_DONE));
    mRecordsToLoad++;
    
    // 读取 AD（Administrative Data）
    mFh.loadEFTransparent(EF_AD, obtainMessage(EVENT_GET_AD_DONE));
    mRecordsToLoad++;
    
    // 读取 MBI（Mailbox Identifier）
    mFh.loadEFLinearFixed(EF_MBI, 1, obtainMessage(EVENT_GET_MBI_DONE));
    mRecordsToLoad++;
    
    // 读取 SPN（Service Provider Name）
    getSpnFsm(true, null);
    
    // 读取 GID1/GID2（Group Identifier）
    mFh.loadEFTransparent(EF_GID1, obtainMessage(EVENT_GET_GID1_DONE));
    mRecordsToLoad++;
    mFh.loadEFTransparent(EF_GID2, obtainMessage(EVENT_GET_GID2_DONE));
    mRecordsToLoad++;
    
    // 读取网络选择相关文件
    mFh.loadEFTransparent(EF_PLMN_W_ACT, obtainMessage(EVENT_GET_PLMN_W_ACT_DONE));
    mRecordsToLoad++;
    mFh.loadEFTransparent(EF_OPLMN_W_ACT, obtainMessage(EVENT_GET_OPLMN_W_ACT_DONE));
    mRecordsToLoad++;
    mFh.loadEFTransparent(EF_HPLMN_W_ACT, obtainMessage(EVENT_GET_HPLMN_W_ACT_DONE));
    mRecordsToLoad++;
    
    // 读取 EHPLMN（Equivalent HPLMN）
    mFh.loadEFTransparent(EF_EHPLMN, obtainMessage(EVENT_GET_EHPLMN_DONE));
    mRecordsToLoad++;
    
    // 读取 FPLMN（Forbidden PLMN）
    mFh.loadEFTransparent(EF_FPLMN, obtainMessage(EVENT_GET_FPLMN_DONE));
    mRecordsToLoad++;
    
    // 读取 PNN（PLMN Network Name）
    mFh.loadEFLinearFixedAll(EF_PNN, obtainMessage(EVENT_GET_PNN_DONE));
    mRecordsToLoad++;
    
    // 读取 OPL（Operator PLMN List）
    mFh.loadEFLinearFixedAll(EF_OPL, obtainMessage(EVENT_GET_OPL_DONE));
    mRecordsToLoad++;
    
    // 读取 SST（SIM Service Table）
    mFh.loadEFTransparent(EF_SST, obtainMessage(EVENT_GET_SST_DONE));
    mRecordsToLoad++;
    
    // ... 更多文件读取
}
```

### 7.3 关键 EF 文件列表

| EF 文件 | 名称 | 类型 | 内容说明 |
|---------|------|------|----------|
| `EF_IMSI` | IMSI | 透明文件 | 国际移动用户识别码，15 位数字 |
| `EF_ICCID` | ICCID | 透明文件 | SIM 卡唯一标识，19-20 位数字 |
| `EF_AD` | Administrative Data | 透明文件 | 管理数据，包含 UE 操作模式 |
| `EF_SPN` | Service Provider Name | 透明文件 | 运营商显示名称 |
| `EF_PNN` | PLMN Network Name | 线性定长 | 网络名称列表 |
| `EF_OPL` | Operator PLMN List | 线性定长 | 运营商 PLMN 列表 |
| `EF_SST` | SIM Service Table | 透明文件 | SIM 服务可用性表 |
| `EF_GID1` | Group Identifier Level 1 | 透明文件 | 组标识 1，用于运营商分组 |
| `EF_GID2` | Group Identifier Level 2 | 透明文件 | 组标识 2 |
| `EF_PLMN_W_ACT` | PLMN with Access Technology | 透明文件 | 用户控制的 PLMN 列表 |
| `EF_OPLMN_W_ACT` | Operator PLMN with Access Technology | 透明文件 | 运营商控制的 PLMN 列表 |
| `EF_HPLMN_W_ACT` | HPLMN with Access Technology | 透明文件 | HPLMN 接入技术列表 |
| `EF_EHPLMN` | Equivalent HPLMN | 透明文件 | 等效 HPLMN 列表 |
| `EF_FPLMN` | Forbidden PLMN | 透明文件 | 禁止注册的 PLMN 列表 |
| `EF_MBI` | Mailbox Identifier | 线性定长 | 语音信箱标识 |
| `EF_MSISDN` | MSISDN | 线性定长 | 用户电话号码 |
| `EF_SPDI` | Service Provider Display Information | 透明文件 | 服务提供商显示信息 |

### 7.4 IccFileHandler 文件读取机制

`IccFileHandler` 封装了与 SIM 卡通信的底层细节。以 `loadEFTransparent` 为例：

```
SIMRecords.fetchSimRecords()
  ↓
mFh.loadEFTransparent(EF_ICCID, Message)
  ↓
IccFileHandler.loadEFTransparent(int fileid, Message onLoaded)
  ↓
// 1. 先发送 SELECT 命令获取文件信息
mCi.iccIOForApp(COMMAND_SELECT, fileid, getEFPath(fileid), 
    0, 0, 0, null, mAid, obtainMessage(EVENT_GET_EF_FILE_RECORD_SIZE_DONE));
  ↓
// 2. 收到文件信息后，发送 READ BINARY 命令读取数据
mCi.iccIOForApp(COMMAND_READ_BINARY, fileid, path, 
    0, 0, size, null, mAid, onLoaded);
  ↓
// 3. 数据返回后，回调给请求者
SIMRecords.handleMessage(EVENT_GET_ICCID_DONE)
```

`IccFileHandler` 内部维护了一个状态机来处理文件读取的多阶段过程：

1. **SELECT**：选择文件并获取文件大小和结构信息
2. **READ**：根据文件类型执行 READ BINARY（透明文件）或 READ RECORD（线性定长文件）
3. **PARSE**：解析返回的原始数据，回调给上层

### 7.5 mRecordsToLoad 计数机制与 onRecordLoaded()

`IccRecords` 使用 `mRecordsToLoad` 计数器来跟踪异步文件读取的完成进度：

```java
// fetchSimRecords 中，每发起一个读取请求
mRecordsToLoad++;

// 每个文件读取完成后
public void onRecordLoaded() {
    mRecordsToLoad--;
    if (mRecordsToLoad == 0) {
        onAllRecordsLoaded();
    }
}
```

这个机制的关键在于：
- `fetchSimRecords()` 中每发起一个异步读取请求，`mRecordsToLoad` 加 1
- 每个读取完成的回调（如 `EVENT_GET_ICCID_DONE`）中调用 `onRecordLoaded()`
- 当 `mRecordsToLoad` 减到 0 时，说明所有记录已加载完成

### 7.6 onAllRecordsLoaded() 完成回调

当所有记录加载完成后，`SIMRecords.onAllRecordsLoaded()` 执行：

```java
protected void onAllRecordsLoaded() {
    // 1. 设置运营商相关系统属性
    setSystemProperty(PROPERTY_ICC_OPERATOR_NUMERIC, mOperatorNumeric);
    setSystemProperty(PROPERTY_ICC_OPERATOR_ISO_COUNTRY, mIsoCountry);
    setSystemProperty(PROPERTY_ICC_OPERATOR_IMSI, mImsi);
    
    // 2. 设置 SPN 显示相关属性
    setSystemProperty(PROPERTY_ICC_OPERATOR_ALPHA, mSpn);
    
    // 3. 通知订阅者记录已加载
    mRecordsLoadedRegistrants.notifyRegistrants(
        new AsyncResult(null, null, null));
    
    // 4. UiccProfile 收到 EVENT_RECORDS_LOADED
    //    → updateExternalState() → 检查所有条件 → setExternalState(LOADED)
}
```

`mRecordsLoadedRegistrants.notifyRegistrants()` 会触发 `UiccProfile` 中注册的监听：

```
SIMRecords.onAllRecordsLoaded()
  ↓
mRecordsLoadedRegistrants.notifyRegistrants()
  ↓
UiccProfile 收到 EVENT_RECORDS_LOADED
  ↓
updateExternalState()
  ├── areAllApplicationsReady() = true
  ├── areAllRecordsLoaded() = true
  ├── areCarrierPrivilegeRulesLoaded() = true
  └── setExternalState(LOADED)
```

---

## 第 8 章 SubscriptionManagerService 与订阅更新

### 8.1 SIM 状态更新到 SubscriptionManagerService

当 `UiccProfile` 状态变为 `LOADED` 后，`setExternalState()` 调用 `UiccController.updateSimState()`，进而通知 `SubscriptionManagerService`：

```
UiccProfile.setExternalState(LOADED)
  ↓
UiccController.updateSimState()
  ↓
SubscriptionManagerService.updateSimState(phoneId, simState)
  ↓
// 更新 SubscriptionInfo 数据库
// 更新运营商信息
// 触发订阅变化通知
```

### 8.2 updateSimState() 异步回调机制

`SubscriptionManagerService.updateSimState()` 的主要职责：

1. 根据 `phoneId` 找到对应的 `SubscriptionInfo`
2. 更新数据库中的 SIM 状态字段
3. 如果状态从非 `LOADED` 变为 `LOADED`，触发订阅信息更新
4. 通知所有监听订阅变化的组件

### 8.3 运营商 ID 解析

`UiccProfile.setExternalState()` 中调用 `resolveSubscriptionCarrierId()`：

```java
private void resolveSubscriptionCarrierId() {
    // 根据 MCC/MNC、GID1、SPN 等信息匹配运营商数据库
    // 生成唯一的 carrierId
    CarrierResolver carrierResolver = new CarrierResolver(mContext);
    int carrierId = carrierResolver.resolveCarrierId(
        mOperatorNumeric, mGid1, mGid2, mSpn, mImsi);
    
    // 设置 carrierId 到 SubscriptionManager
    SubscriptionManagerService.getInstance().setCarrierId(phoneId, carrierId);
}
```

运营商 ID 的解析依据优先级：
1. MCC/MNC（移动国家码/移动网络码）
2. GID1（组标识 1）
3. GID2（组标识 2）
4. SPN（服务提供商名称）
5. IMSI 前缀

### 8.4 运营商服务绑定

`updateCarrierServices()` 负责绑定运营商特定的服务：

```java
private void updateCarrierServices() {
    // 1. 加载运营商配置（CarrierConfig）
    CarrierConfigManager configManager = 
        (CarrierConfigManager) mContext.getSystemService(Context.CARRIER_CONFIG_SERVICE);
    configManager.updateConfigForPhoneId(mPhoneId);
    
    // 2. 触发运营商应用绑定
    // 3. 更新 APN 配置
    // 4. 更新 IMS 配置
}
```

---

## 第 9 章 典型场景分析

### 9.1 正常开机 SIM 加载成功全流程

正常开机场景是本文档的核心流程，完整的调用时序：

```
[开机启动]
  ↓
PhoneFactory.makeDefaultPhone()
  ↓
UiccController.make() ───────────────────────┐
  ├── 创建 UiccSlot[]                        │
  └── 注册 RIL 事件监听                       │
                                              │
[Modem 初始化完成，检测到 SIM 卡]              │
  ↓                                           │
IRadioSimIndication.simStatusChanged()        │
  ↓                                           │
SimIndication.simStatusChanged()              │
  ↓                                           │
UiccController.handleMessage(                 │
    EVENT_ICC_STATUS_CHANGED)                 │
  ↓                                           │
mCis[phoneId].getIccCardStatus()              │
  ↓                                           │
RIL → RadioSimProxy → IRadioSim (AIDL) ──────┤
  ↓ AIDL 请求                                 │
Modem 处理                                    │
  ↓ AIDL 响应                                 │
SimResponse.getIccCardStatusResponse() ──────┘
  ↓
UiccController.onGetIccCardStatusDone()
  ├── UiccSlot.update() → 创建 UiccCard
  ├── UiccCard.update() → 创建 UiccPort
  ├── UiccPort.update() → 创建 UiccProfile
  │   ├── UiccProfile.update() → 创建 UiccCardApplication[]
  │   │   ├── 创建 IccFileHandler
  │   │   └── 创建 IccRecords (SIMRecords)
  │   ├── registerAllAppEvents()
  │   └── updateExternalState() → NOT_READY
  └── mIccChangedRegistrants.notifyRegistrants()

[UiccCardApplication 状态变为 APPSTATE_READY]
  ↓
notifyReadyRegistrantsIfNeeded()
  ↓
UiccProfile: EVENT_APP_READY
  ↓
updateExternalState() → READY
  ↓
SIMRecords.onReady() → fetchSimRecords()
  ├── 发起 20+ 个 EF 文件读取请求
  ├── mRecordsToLoad = N
  └── 每个文件读取完成 → onRecordLoaded() → mRecordsToLoad--

[所有文件读取完成]
  ↓
mRecordsToLoad == 0
  ↓
SIMRecords.onAllRecordsLoaded()
  ├── 设置系统属性
  └── mRecordsLoadedRegistrants.notifyRegistrants()
        ↓
    UiccProfile: EVENT_RECORDS_LOADED
        ↓
    updateExternalState()
      ├── areAllApplicationsReady() = true
      ├── areAllRecordsLoaded() = true
      ├── areCarrierPrivilegeRulesLoaded() = true
      └── setExternalState(LOADED)
            ├── SystemProperties.set("gsm.sim.state", "LOADED")
            ├── UiccController.updateSimState()
            │   ├── TelephonyManager.setSimStateForPhone()
            │   ├── SubscriptionManagerService.updateSimState()
            │   ├── broadcastSimStateChanged(LOADED)
            │   ├── broadcastSimCardStateChanged(PRESENT)
            │   └── broadcastSimApplicationStateChanged(LOADED)
            ├── resolveSubscriptionCarrierId()
            └── updateCarrierServices()
```

### 9.2 SIM 卡锁定场景（PIN/PUK/Network Lock）

当 SIM 卡需要 PIN 码解锁时：

```
UiccProfile.updateExternalState()
  ↓
检查 UiccCardApplication 状态
  ├── APPSTATE_PIN → setExternalState(PIN_REQUIRED)
  ├── APPSTATE_PUK → setExternalState(PUK_REQUIRED)
  └── APPSTATE_SUBSCRIPTION_PERSO → setExternalState(NETWORK_LOCKED)
```

用户输入 PIN 码后：

```
Settings / SystemUI
  ↓
IccCardProxy.supplyPin(pin)
  ↓
UiccCardApplication.supplyPin(pin, onComplete)
  ↓
RIL.supplyIccPinForApp(pin, aid, onComplete)
  ↓ AIDL
Modem 验证 PIN
  ↓
SimResponse.supplyIccPinForAppResponse()
  ↓
UiccCardApplication: 状态从 APPSTATE_PIN → APPSTATE_READY
  ↓
notifyReadyRegistrantsIfNeeded()
  ↓
继续正常加载流程（READY → LOADED）
```

### 9.3 SIM 卡拔出（Absent 状态）

当用户拔出 SIM 卡时：

```
Modem 检测到 SIM 卡移除
  ↓
IRadioSimIndication.simStatusChanged()
  ↓
UiccController: EVENT_ICC_STATUS_CHANGED
  ↓
getIccCardStatus()
  ↓
SimResponse: CardStatus.mCardState = CARDSTATE_ABSENT
  ↓
UiccController.onGetIccCardStatusDone()
  ↓
UiccSlot.update() → 卡状态变为 ABSENT
  ├── UiccSlot 置空 mUiccCard
  ├── UiccCard.dispose() → 级联释放所有资源
  │   ├── UiccPort.dispose()
  │   │   ├── UiccProfile.dispose()
  │   │   │   ├── UiccCardApplication.dispose()
  │   │   │   │   ├── IccRecords.dispose()
  │   │   │   │   └── IccFileHandler.dispose()
  │   │   │   └── CatService.dispose()
  └── updateExternalState() → ABSENT
  ↓
UiccController.updateSimState()
  ├── broadcastSimStateChanged(ABSENT)
  └── SubscriptionManagerService 清除订阅信息
```

### 9.4 SIM 卡热插拔

热插拔流程是"拔出"和"插入"两个流程的组合。插入新卡后， Modem 会上报 `simStatusChanged`，Framework 重新走完整的加载流程。

需要注意的是，热插拔时 `UiccSlot` 对象通常不会销毁，只是更新其中的 `UiccCard`；而 `UiccCard` 及以下的所有对象（`UiccPort`、`UiccProfile`、`UiccCardApplication`、`IccRecords`、`IccFileHandler`）都会被重新创建。

### 9.5 双卡场景下的状态管理

在 DSDS 场景下：

- 每个 `phoneId` 有独立的 RIL 实例和 UICC 对象树
- `UiccController` 维护 `mPhoneIdToSlotId` 映射，处理物理卡槽与逻辑 phone 的对应关系
- 两个卡槽的加载流程完全独立，互不影响
- `SubscriptionManagerService` 需要维护两个 `SubscriptionInfo`
- 状态广播中通过 `phone` 或 `slot_index` 字段区分不同卡槽

---

## 第 10 章 调试与日志

### 10.1 关键 Log TAG

| TAG | 说明 |
|-----|------|
| `UiccController` | UICC 控制器核心日志 |
| `UiccProfile` | Profile 状态机日志 |
| `UiccCard` / `UiccSlot` / `UiccPort` | UICC 层级日志 |
| `SIMRecords` | SIM 记录加载日志 |
| `IccFileHandler` | 文件读取日志 |
| `RILJ` | RIL Java 层日志 |
| `SimIndication` / `SimResponse` | AIDL HAL 回调日志 |
| `CarrierResolver` | 运营商 ID 解析日志 |

### 10.2 常用调试命令

```bash
adb shell dumpsys telephony.registry

adb shell dumpsys icc

adb shell dumpsys subscription

adb shell getprop | grep gsm.sim

adb logcat -s UiccController UiccProfile SIMRecords IccFileHandler RILJ

adb shell dumpsys telephony
```

### 10.3 常见问题排查思路

**问题 1：SIM 卡状态卡在 NOT_READY**

排查步骤：
1. 检查 Radio 是否可用：`adb shell getprop gsm.radio.state`
2. 查看 `UiccController` 日志，确认是否收到 `EVENT_ICC_STATUS_CHANGED`
3. 查看 `RILJ` 日志，确认 `getIccCardStatus` 请求是否下发及响应
4. 检查 `UiccCardApplication` 状态，确认是否卡在 `APPSTATE_DETECTED` 等非 READY 状态
5. 检查 Modem 日志，确认 SIM 卡初始化是否成功

**问题 2：LOADED 状态不触发**

排查步骤：
1. 确认所有 `UiccCardApplication` 是否都已变为 `APPSTATE_READY`
2. 查看 `SIMRecords` 日志，检查 `fetchSimRecords` 是否完成（`mRecordsToLoad` 是否为 0）
3. 检查是否有文件读取持续失败（`IccFileHandler` 错误日志）
4. 确认 `CarrierPrivilegeRules` 是否加载完成
5. 查看 `UiccProfile` 日志，确认 `updateExternalState()` 的决策逻辑

**问题 3：双卡状态不一致**

排查步骤：
1. 分别查看两个卡槽的 `UiccSlot` 状态
2. 检查 `mPhoneIdToSlotId` 映射是否正确
3. 确认两个 RIL 实例是否独立工作
4. 查看 `SubscriptionManagerService` 中两个订阅的信息

**问题 4：热插拔后 SIM 不识别**

排查步骤：
1. 确认 `UiccSlot` 是否正确更新了卡状态
2. 检查旧 `UiccCard` 是否已正确 `dispose()`
3. 确认新卡加载流程是否完整执行
4. 查看 Modem 是否上报了 `simStatusChanged`

---

## 附录：核心类源码路径速查

| 类 | AOSP 路径 |
|----|-----------|
| `PhoneFactory` | `frameworks/opt/telephony/src/java/com/android/internal/telephony/PhoneFactory.java` |
| `UiccController` | `frameworks/opt/telephony/src/java/com/android/internal/telephony/uicc/UiccController.java` |
| `UiccSlot` | `frameworks/opt/telephony/src/java/com/android/internal/telephony/uicc/UiccSlot.java` |
| `UiccCard` | `frameworks/opt/telephony/src/java/com/android/internal/telephony/uicc/UiccCard.java` |
| `UiccPort` | `frameworks/opt/telephony/src/java/com/android/internal/telephony/uicc/UiccPort.java` |
| `UiccProfile` | `frameworks/opt/telephony/src/java/com/android/internal/telephony/uicc/UiccProfile.java` |
| `UiccCardApplication` | `frameworks/opt/telephony/src/java/com/android/internal/telephony/uicc/UiccCardApplication.java` |
| `IccRecords` | `frameworks/opt/telephony/src/java/com/android/internal/telephony/uicc/IccRecords.java` |
| `SIMRecords` | `frameworks/opt/telephony/src/java/com/android/internal/telephony/uicc/SIMRecords.java` |
| `IccFileHandler` | `frameworks/opt/telephony/src/java/com/android/internal/telephony/uicc/IccFileHandler.java` |
| `IccCardStatus` | `frameworks/opt/telephony/src/java/com/android/internal/telephony/uicc/IccCardStatus.java` |
| `RIL` | `frameworks/opt/telephony/src/java/com/android/internal/telephony/RIL.java` |
| `SimIndication` | `frameworks/opt/telephony/src/java/com/android/internal/telephony/SimIndication.java` |
| `SimResponse` | `frameworks/opt/telephony/src/java/com/android/internal/telephony/SimResponse.java` |
| `SubscriptionManagerService` | `frameworks/opt/telephony/src/java/com/android/internal/telephony/subscription/SubscriptionManagerService.java` |
| `IRadioSim` | `hardware/interfaces/radio/sim/IRadioSim.aidl` |
| `IRadioSimIndication` | `hardware/interfaces/radio/sim/IRadioSimIndication.aidl` |
| `IRadioSimResponse` | `hardware/interfaces/radio/sim/IRadioSimResponse.aidl` |