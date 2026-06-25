---
title: "Android 5G 网络制式显示全流程分析"
date: "2025-06-25"
summary: "基于 AOSP 源码，从 NetworkTypeController 状态机到 SystemUI 状态栏 5G 图标显示的全流程分析，涵盖 NR 状态定义、NetworkTypeController 状态机、DisplayInfoController 广播与 SystemUI 图标渲染。"
category: "network-search"
tags: ["NetworkTypeController", "DisplayInfoController", "5G", "NR", "ServiceState", "SystemUI", "TelephonyDisplayInfo", "RIL", "SA", "NSA"]
featured: true
---

> **文档定位**：基于 AOSP 源码，从 NetworkTypeController 状态机到 SystemUI 状态栏 5G 图标显示的全流程分析

---

## 第1章 架构总览

Android 5G 网络制式显示涉及从 Modem 底层上报到 SystemUI 状态栏图标渲染的完整链路，跨越四个核心模块：

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Modem/RIL  │────→│ ServiceStateTracker│────→│ NetworkRegistrationInfo │
└─────────────┘     └──────────────────┘     └─────────────────┘
         │                                         │
         │              ┌──────────────────┐       │
         └─────────────→│ PhysicalChannelConfig│←──┘
                        └──────────────────┘
                                │
                                ▼
                    ┌──────────────────┐
                    │ NetworkTypeController│ ← 状态机核心决策
                    │  (overrideNetworkType)│
                    └──────────────────┘
                                │
                                ▼
                    ┌──────────────────┐
                    │ DisplayInfoController│
                    │  (TelephonyDisplayInfo)│
                    └──────────────────┘
                                │
                    ┌───────────┴───────────┐
                    ▼                       ▼
         ┌──────────────────┐    ┌──────────────────┐
         │   Phone/Notifier  │───→│  TelephonyRegistry│
         └──────────────────┘    └──────────────────┘
                                              │
                                              ▼
                                    ┌──────────────────┐
                                    │ TelephonyCallback │
                                    │  .DisplayInfoListener│
                                    └──────────────────┘
                                              │
                                              ▼
                                    ┌──────────────────┐
                                    │ MobileStatusTracker│
                                    └──────────────────┘
                                              │
                                              ▼
                                    ┌──────────────────┐
                                    │MobileSignalController│
                                    │   .updateTelephony() │
                                    └──────────────────┘
                                              │
                                              ▼
                                    ┌──────────────────┐
                                    │  MobileMappings   │
                                    │   .getIconKey()   │
                                    └──────────────────┘
                                              │
                                              ▼
                                    ┌──────────────────┐
                                    │  TelephonyIcons   │
                                    │ (MobileIconGroup) │
                                    └──────────────────┘
                                              │
                                              ▼
                                    ┌──────────────────┐
                                    │  SystemUI 状态栏  │
                                    │   5G 图标渲染     │
                                    └──────────────────┘
```

**模块职责划分：**

| 模块 | 层级 | 核心职责 |
|------|------|---------|
| `ServiceStateTracker` | Telephony 进程 | 接收 Modem/RIL 上报的网络注册信息，维护 `ServiceState` 和 `NetworkRegistrationInfo`，解析 NR 状态 |
| `NetworkTypeController` | Telephony 进程 | 状态机，根据数据 RAT、NR 状态、物理链路状态和运营商配置，计算 `overrideNetworkType` |
| `DisplayInfoController` | Telephony 进程 | 组装 `TelephonyDisplayInfo` 并广播变更通知 |
| `TelephonyRegistry` | System Service | 跨进程桥接，将 Telephony 进程的显示信息变更通知到所有注册的 `TelephonyCallback` 监听者 |
| `MobileSignalController` | SystemUI 进程 | 接收 `TelephonyDisplayInfo`，通过 `MobileMappings` 映射到对应的图标资源，驱动 UI 更新 |

---

## 第2章 NR 状态定义与上报

### 2.1 NR 状态常量

`NetworkRegistrationInfo` 定义了 4 种 NR（New Radio，即 5G）连接状态：

```java
// NetworkRegistrationInfo.java:148-178
public static final int NR_STATE_NONE = 0;           // 非 LTE 或不支持 EN-DC
public static final int NR_STATE_RESTRICTED = 1;      // 支持 EN-DC 但 NR 受限
public static final int NR_STATE_NOT_RESTRICTED = 2;  // 支持 EN-DC 且 NR 不受限
public static final int NR_STATE_CONNECTED = 3;       // 已连接至少一个 5G 小区
```

| NR 状态 | 值 | 含义 | 典型场景 |
|---------|---|------|---------|
| `NR_STATE_NONE` | 0 | 无 NR 可用 | 2G/3G 网络，或 LTE 小区不支持 EN-DC |
| `NR_STATE_RESTRICTED` | 1 | NR 受限 | LTE 小区支持 EN-DC，但 DCNR 被限制 |
| `NR_STATE_NOT_RESTRICTED` | 2 | NR 不受限 | LTE 小区支持 EN-DC 且 DCNR 不受限，但尚未连接 NR 辅小区 |
| `NR_STATE_CONNECTED` | 3 | NR 已连接 | 已通过 EN-DC 连接到 NR 辅小区，或 SA 模式下直接驻留在 NR |

### 2.2 NSA 场景下 NR 状态计算

`updateNrState()` 方法处理 NSA（Non-Standalone）场景下的 NR 状态判定：

```java
// NetworkRegistrationInfo.java:1004-1013
public void updateNrState() {
    mNrState = NR_STATE_NONE;
    if (mDataSpecificInfo != null && mDataSpecificInfo.isEnDcAvailable) {
        if (!mDataSpecificInfo.isDcNrRestricted && mDataSpecificInfo.isNrAvailable) {
            mNrState = NR_STATE_NOT_RESTRICTED;
        } else {
            mNrState = NR_STATE_RESTRICTED;
        }
    }
}
```

判定逻辑：
1. 如果 EN-DC 不可用 → `NR_STATE_NONE`
2. 如果 EN-DC 可用且 DCNR 不受限且 NR 可用 → `NR_STATE_NOT_RESTRICTED`
3. 如果 EN-DC 可用但 DCNR 受限或 NR 不可用 → `NR_STATE_RESTRICTED`

### 2.3 SA 场景下 NR 状态设置

SA（Standalone）场景下，`NR_STATE_CONNECTED` 由 `ServiceStateTracker` 根据 `PhysicalChannelConfig` 直接设置：

```java
// ServiceStateTracker.java:1729-1734
int oldNrState = regInfo.getNrState();
int newNrState;
if (hasNrSecondaryServingCell) {
    newNrState = NetworkRegistrationInfo.NR_STATE_CONNECTED;
} else {
    regInfo.updateNrState();
    // ...
}
```

当检测到 NR 辅服务小区存在时，直接将 NR 状态设为 `NR_STATE_CONNECTED`。

### 2.4 ServiceState 获取 NR 状态

`ServiceState.getNrState()` 从 PS 域 WWAN 传输的 `NetworkRegistrationInfo` 中提取 NR 状态：

```java
// ServiceState.java:1447-1452
public @NRState int getNrState() {
    final NetworkRegistrationInfo regInfo = getNetworkRegistrationInfo(
            NetworkRegistrationInfo.DOMAIN_PS, AccessNetworkConstants.TRANSPORT_TYPE_WWAN);
    if (regInfo == null) return NetworkRegistrationInfo.NR_STATE_NONE;
    return regInfo.getNrState();
}
```

---

## 第3章 NetworkTypeController 状态机详解

`NetworkTypeController` 是 5G 图标显示的**核心决策引擎**，它是一个 `StateMachine`。

源码位置：`telephony/src/java/com/android/internal/telephony/NetworkTypeController.java`

### 3.1 状态层次结构

```java
// NetworkTypeController.java:344-351
DefaultState
  ├── LegacyState              // 非 5G 状态（2G/3G/普通 LTE）
  ├── IdleState                // LTE 连接 + NR 不受限，RRC 空闲
  ├── LteConnectedState        // LTE 连接 + NR 不受限，RRC 连接态
  ├── NrIdleState              // 已注册 NR 但未活跃使用数据（RRC 空闲）
  ├── NrConnectedState         // NR 连接态（5G）
  └── NrConnectedAdvancedState // NR 高级连接态（5G+）
```

各状态的名称标识（用于 timer rule 匹配）：

| 状态类 | 名称标识 | 含义 |
|--------|---------|------|
| `LegacyState` | `"legacy"` / `"restricted"` | 无 NR 可用，或 NR 受限 |
| `IdleState` | `"not_restricted_rrc_idle"` | LTE + NR 不受限，RRC 空闲 |
| `LteConnectedState` | `"not_restricted_rrc_con"` | LTE + NR 不受限，RRC 连接态 |
| `NrIdleState` | `"connected_rrc_idle"` | NR 已注册但 RRC 空闲 |
| `NrConnectedState` | `"connected"` | NR 已连接，普通 5G |
| `NrConnectedAdvancedState` | `"connected_mmwave"` | NR 高级连接，5G+ |

### 3.2 状态机事件定义

```java
// NetworkTypeController.java:98-120
EVENT_UPDATE                              // 停止所有 timer，跳转到当前状态
EVENT_SERVICE_STATE_CHANGED               // 服务状态变更（数据 RAT、带宽、NR 状态等）
EVENT_PHYSICAL_LINK_STATUS_CHANGED       // 物理链路状态变更
EVENT_PHYSICAL_CHANNEL_CONFIG_NOTIF_CHANGED  // 物理信道配置通知开关
EVENT_CARRIER_CONFIG_CHANGED             // 运营商配置变更
EVENT_PRIMARY_TIMER_EXPIRED               // 主 timer 到期
EVENT_SECONDARY_TIMER_EXPIRED            // 次 timer 到期
EVENT_RADIO_OFF_OR_UNAVAILABLE           // 关机或不可用
EVENT_PREFERRED_NETWORK_MODE_CHANGED     // 首选网络模式变更
EVENT_PHYSICAL_CHANNEL_CONFIGS_CHANGED    // 物理信道配置变更
```

### 3.3 核心状态转换方法

`transitionToCurrentState()` 是状态机的核心路由方法：

```java
// NetworkTypeController.java:1602-1628
private void transitionToCurrentState() {
    int dataRat = getDataNetworkType();
    IState transitionState;
    if (dataRat == TelephonyManager.NETWORK_TYPE_NR
            || (isLte(dataRat) && isNrConnected())) {
        if (!isPhysicalLinkActive()) {
            transitionState = mNrIdleState;               // NR 空闲
        } else if (isNrAdvanced()) {
            transitionState = mNrConnectedAdvancedState;  // 5G+
        } else {
            transitionState = mNrConnectedState;          // 5G 连接
        }
    } else if (isLte(dataRat) && isNrNotRestricted()) {
        if (isPhysicalLinkActive()) {
            transitionState = mLteConnectedState;        // LTE 连接 + NR 可用
        } else {
            transitionState = mIdleState;                 // LTE + NR 可用，RRC 空闲
        }
    } else {
        transitionState = mLegacyState;                   // 非 5G
    }
    // ...
}
```

### 3.4 IdleState → NrIdleState 转换详解

这是用户关注的**核心转换路径**。

#### 转换触发条件

在 `IdleState.processMessage()` 中，当收到 `EVENT_SERVICE_STATE_CHANGED` 或 `EVENT_UPDATE` 事件时：

```java
// NetworkTypeController.java:1024-1033 (IdleState)
case EVENT_SERVICE_STATE_CHANGED:
    onServiceStateChanged();
    // fallthrough
case EVENT_UPDATE:
    int rat = getDataNetworkType();
    if (rat == TelephonyManager.NETWORK_TYPE_NR
            || (isLte(rat) && isNrConnected())) {
        if (isNrAdvanced()) {
            transitionTo(mNrConnectedAdvancedState);     // → 5G+
        } else {
            transitionTo(isPhysicalLinkActive()
                    ? mNrConnectedState : mNrIdleState);  // ★ → NrIdleState
        }
    }
```

进入 `NrIdleState` 需要同时满足：
1. **数据 RAT 为 NR**（SA 场景）**或** 数据 RAT 为 LTE 且 NR 状态为 CONNECTED（NSA 场景）
2. **物理链路不活跃**（`!isPhysicalLinkActive()`），即 RRC 空闲状态
3. **不是 NR Advanced**（`!isNrAdvanced()`）

#### NrIdleState 的进入行为

```java
// NetworkTypeController.java:1170-1178 (NrIdleState.enter)
public void enter() {
    if (DBG) log("Entering NrIdleState");
    updateTimers();
    updateOverrideNetworkType();
    if (!mIsPrimaryTimerActive && !mIsSecondaryTimerActive) {
        mPreviousState = getName();
    }
}
```

进入 `NrIdleState` 后立即执行两个关键操作：
- `updateTimers()` — 根据当前状态和运营商配置更新 timer 规则
- `updateOverrideNetworkType()` — 重新计算 override 网络类型并通知 `DisplayInfoController`

#### NrIdleState 的消息处理

```java
// NetworkTypeController.java:1186-1234 (NrIdleState.processMessage)
switch (msg.what) {
    case EVENT_SERVICE_STATE_CHANGED:
        onServiceStateChanged();
        // fallthrough
    case EVENT_UPDATE:
        int rat = getDataNetworkType();
        if (rat == NETWORK_TYPE_NR || (isLte(rat) && isNrConnected())) {
            if (isNrAdvanced()) {
                // 忽略：idle 状态下不因缓存的 PCC 而跳转到 advanced
            } else if (isPhysicalLinkActive()) {
                transitionWithTimerTo(mNrConnectedState);  // → 5G 连接
            } else {
                updateOverrideNetworkType();               // 保持 idle
            }
        } else if (isLte(rat) && isNrNotRestricted()) {
            transitionWithTimerTo(isPhysicalLinkActive()
                    ? mLteConnectedState : mIdleState);   // → 回退到 LTE 状态
        } else {
            transitionWithTimerTo(mLegacyState);           // → 非 5G
        }
        break;
    case EVENT_PHYSICAL_CHANNEL_CONFIGS_CHANGED:
        // ... 物理链路激活 → NrConnected/NrConnectedAdvanced
        if (isPhysicalLinkActive()) {
            if (isNrAdvanced()) {
                transitionTo(mNrConnectedAdvancedState);    // → 5G+
            } else {
                transitionWithTimerTo(mNrConnectedState);   // → 5G 连接
            }
        }
        break;
    case EVENT_PHYSICAL_LINK_STATUS_CHANGED:
        mPhysicalLinkStatus = msg.arg1;
        if (isPhysicalLinkActive()) {
            transitionWithTimerTo(mNrConnectedState);      // → 5G 连接
        }
        break;
}
```

### 3.5 Override Network Type 计算

#### updateOverrideNetworkType

```java
// NetworkTypeController.java:652-659
private void updateOverrideNetworkType() {
    if (mIsPrimaryTimerActive || mIsSecondaryTimerActive) {
        if (DBG) log("Skip updating override network type since timer is active.");
        return;
    }
    mOverrideNetworkType = getCurrentOverrideNetworkType();
    mDisplayInfoController.updateTelephonyDisplayInfo();
}
```

当 timer 活跃时，跳过更新以防止 5G 图标闪烁。

#### getCurrentOverrideNetworkType

```java
// NetworkTypeController.java:671-694
private int getCurrentOverrideNetworkType() {
    int displayNetworkType = OVERRIDE_NETWORK_TYPE_NONE;
    int dataNetworkType = getRawDataNetworkType();

    boolean nrNsa = isLte(dataNetworkType)
            && mServiceState.getNrState() != NR_STATE_NONE;
    boolean nrSa = dataNetworkType == NETWORK_TYPE_NR;

    if (mIsPhysicalChannelConfigOn && (nrNsa || nrSa)) {
        displayNetworkType = getNrDisplayType(nrSa);
        if (displayNetworkType == OVERRIDE_NETWORK_TYPE_NONE && !nrSa) {
            displayNetworkType = getLteDisplayType();  // 回退到 LTE 显示
        }
    } else if (isLte(dataNetworkType)) {
        displayNetworkType = getLteDisplayType();
    }
    return displayNetworkType;
}
```

#### getNrDisplayType — carrier config timer rule 匹配

```java
// NetworkTypeController.java:696-734
private int getNrDisplayType(boolean isNrSa) {
    // 如果首选网络类型不包含 5G，不显示 5G 图标
    if ((mPhone.getCachedAllowedNetworkTypesBitmask()
            & NETWORK_TYPE_BITMASK_NR) == 0) {
        return OVERRIDE_NETWORK_TYPE_NONE;
    }

    List<String> keys = new ArrayList<>();
    if (isNrSa) {
        if (isNrAdvanced()) keys.add(STATE_CONNECTED_NR_ADVANCED);
    } else {
        switch (mServiceState.getNrState()) {
            case NR_STATE_CONNECTED:
                if (isNrAdvanced()) keys.add(STATE_CONNECTED_NR_ADVANCED);
                keys.add(STATE_CONNECTED);
                break;
            case NR_STATE_NOT_RESTRICTED:
                keys.add(isPhysicalLinkActive()
                        ? STATE_NOT_RESTRICTED_RRC_CON
                        : STATE_NOT_RESTRICTED_RRC_IDLE);
                break;
            case NR_STATE_RESTRICTED:
                keys.add(STATE_RESTRICTED);
                break;
        }
    }

    // 按优先级匹配 carrier config 定义的 override timer rule
    for (String key : keys) {
        OverrideTimerRule rule = mOverrideTimerRules.get(key);
        if (rule != null && rule.mOverrideType != OVERRIDE_NETWORK_TYPE_NONE) {
            return rule.mOverrideType;
        }
    }
    return OVERRIDE_NETWORK_TYPE_NONE;
}
```

该方法的核心逻辑是：
1. 根据当前 NR 状态和物理链路状态，生成一组候选 key（按优先级排列）
2. 依次在运营商配置的 `mOverrideTimerRules` 中查找匹配的 rule
3. 返回匹配到的 `overrideType`（如 `NR_NSA`、`NR_ADVANCED` 等）

### 3.6 Timer 机制

NetworkTypeController 实现了**主/次两级 timer** 机制，防止 5G 图标在状态快速切换时闪烁：

```java
// NetworkTypeController.java:1540-1600
private void transitionWithTimerTo(IState destState) {
    String destName = destState.getName();
    // ...
    OverrideTimerRule rule = mOverrideTimerRules.get(mPreviousState);
    if (!mIsDeviceIdleMode && rule != null && rule.getTimer(destName) > 0) {
        int duration = rule.getTimer(destName);
        mPrimaryTimerState = mPreviousState;
        mIsPrimaryTimerActive = true;
        sendMessageDelayed(EVENT_PRIMARY_TIMER_EXPIRED, destState, duration * 1000L);
    }
    // ...
    transitionTo(getCurrentState());
}
```

- **主 timer**：从源状态跳转到目标状态时启动，在 timer 到期前保持源状态的图标显示
- **次 timer**：主 timer 到期后启动，提供额外的缓冲时间
- timer 的具体时长由运营商通过 `CarrierConfig` 配置

### 3.7 状态转换全景图

```
                              ┌────────────────────────────┐
                              │        [*] 启动            │
                              └────────────┬───────────────┘
                                           │
                                           ▼
                              ┌────────────────────────────┐
                              │        LegacyState          │
                              │     (非5G / NR受限)         │
                              └────────────┬───────────────┘
           ┌───────────────────────────────┼───────────────────────────────┐
           │                               │                               │
           ▼                               ▼                               ▼
┌────────────────────┐          ┌────────────────────┐          ┌────────────────────┐
│     IdleState       │          │   LteConnectedState │          │    NrIdleState      │
│ (LTE+NR不受限,RRC空闲)│          │(LTE+NR不受限,RRC连接) │          │  (NR已注册,RRC空闲)  │
└─────────┬──────────┘          └─────────┬──────────┘          └─────────┬──────────┘
          │                               │                               │
          │    physicalLinkActive         │    !physicalLinkActive        │    physicalLinkActive
          │        ↓                      │        ↓                      │        ↓
          ▼                               ▼                               ▼
┌────────────────────┐          ┌────────────────────┐          ┌────────────────────┐
│   NrIdleState       │          │     IdleState       │          │  NrConnectedState   │
│                     │          │                     │          │    (5G 连接)         │
└─────────────────────┘          └─────────────────────┘          └─────────┬──────────┘
                                                                            │
                                                                            │ isNrAdvanced
                                                                            ▼
                                                               ┌────────────────────┐
                                                               │ NrConnectedAdvanced│
                                                               │     (5G+)          │
                                                               └────────────────────┘

转换规则说明：
- LegacyState → IdleState       : LTE + NR_NOT_RESTRICTED + !physicalLinkActive
- LegacyState → LteConnectedState: LTE + NR_NOT_RESTRICTED + physicalLinkActive
- LegacyState → NrIdleState      : NR_CONNECTED + !physicalLinkActive
- LegacyState → NrConnectedState : NR_CONNECTED + physicalLinkActive
- IdleState → NrIdleState        : NR_CONNECTED + !physicalLinkActive
- IdleState → LteConnectedState  : physicalLinkActive
- NrIdleState → NrConnectedState : physicalLinkActive
- NrIdleState → IdleState        : LTE + NR_NOT_RESTRICTED + !physicalLinkActive
- NrConnectedState → NrIdleState : !physicalLinkActive
- 所有带 timer 的转换使用 transitionWithTimerTo()，在 timer 到期前保持源状态图标
```

---

## 第4章 DisplayInfoController 与 TelephonyDisplayInfo

### 4.1 DisplayInfoController

`DisplayInfoController` 负责组装 `TelephonyDisplayInfo` 并广播变更。

源码位置：`telephony/src/java/com/android/internal/telephony/DisplayInfoController.java`

#### 初始化流程

```java
// DisplayInfoController.java:84-129
public DisplayInfoController(Phone phone, FeatureFlags featureFlags) {
    mPhone = phone;
    mServiceState = mPhone.getServiceStateTracker().getServiceState();
    // ...
    mTelephonyDisplayInfo = new TelephonyDisplayInfo(
            NETWORK_TYPE_UNKNOWN, OVERRIDE_NETWORK_TYPE_NONE, false, false, false);
    mNetworkTypeController = new NetworkTypeController(phone, this, featureFlags);
    // 发送 EVENT_UPDATE，触发状态机从 DefaultState 跳转到当前状态
    mNetworkTypeController.sendMessage(NetworkTypeController.EVENT_UPDATE);
}
```

#### updateTelephonyDisplayInfo

```java
// DisplayInfoController.java:142-161
public void updateTelephonyDisplayInfo() {
    if (mNetworkTypeController != null && mServiceState != null) {
        TelephonyDisplayInfo newDisplayInfo = new TelephonyDisplayInfo(
                mNetworkTypeController.getDataNetworkType(),
                mNetworkTypeController.getOverrideNetworkType(),
                isRoaming(),
                mServiceState.isUsingNonTerrestrialNetwork(),
                mNetworkTypeController.getSatelliteConstrainedData());
        if (!newDisplayInfo.equals(mTelephonyDisplayInfo)) {
            mTelephonyDisplayInfo = newDisplayInfo;
            validateDisplayInfo(newDisplayInfo);
            mTelephonyDisplayInfoChangedRegistrants.notifyRegistrants();
            mPhone.notifyDisplayInfoChanged(mTelephonyDisplayInfo);
        }
    }
}
```

`TelephonyDisplayInfo` 由 5 个字段组成：

| 字段 | 来源 | 说明 |
|------|------|------|
| `networkType` | `NetworkTypeController.getDataNetworkType()` | 实际数据 RAT 类型 |
| `overrideNetworkType` | `NetworkTypeController.getOverrideNetworkType()` | 覆盖网络类型（决定 5G 图标） |
| `isRoaming` | `ServiceState.getRoaming()` + carrier config | 漫游状态（受运营商配置覆盖） |
| `isNtn` | `ServiceState.isUsingNonTerrestrialNetwork()` | 是否非地面网络（卫星） |
| `isSatelliteConstrainedData` | `NetworkTypeController.getSatelliteConstrainedData()` | 卫星带宽受限 |

#### 有效显示信息组合

```java
// DisplayInfoController.java:54-68
private static final Set<Pair<Integer, Integer>> VALID_DISPLAY_INFO_SET = Set.of(
    Pair.create(NETWORK_TYPE_LTE, OVERRIDE_NETWORK_TYPE_LTE_CA),
    Pair.create(NETWORK_TYPE_LTE, OVERRIDE_NETWORK_TYPE_LTE_ADVANCED_PRO),
    Pair.create(NETWORK_TYPE_LTE, OVERRIDE_NETWORK_TYPE_NR_NSA),
    Pair.create(NETWORK_TYPE_LTE, OVERRIDE_NETWORK_TYPE_NR_ADVANCED),
    Pair.create(NETWORK_TYPE_NR, OVERRIDE_NETWORK_TYPE_NR_ADVANCED)
);
```

### 4.2 广播路径

```
DisplayInfoController.updateTelephonyDisplayInfo()
  → Phone.notifyDisplayInfoChanged(telephonyDisplayInfo)
    → DefaultPhoneNotifier.notifyDisplayInfoChanged()
      → TelephonyRegistryManager.notifyDisplayInfoChanged()
        → [跨进程] TelephonyRegistry.notifyDisplayInfoChanged()
          → TelephonyCallback.DisplayInfoListener.onDisplayInfoChanged()
```

---

## 第5章 TelephonyDisplayInfo 数据结构

源码位置：`base/telephony/java/android/telephony/TelephonyDisplayInfo.java`

### 5.1 Override Network Type 常量

```java
// TelephonyDisplayInfo.java:42-87
OVERRIDE_NETWORK_TYPE_NONE              = 0  // 无覆盖
OVERRIDE_NETWORK_TYPE_LTE_CA            = 1  // LTE 载波聚合
OVERRIDE_NETWORK_TYPE_LTE_ADVANCED_PRO  = 2  // LTE Advanced Pro (5G E)
OVERRIDE_NETWORK_TYPE_NR_NSA            = 3  // 5G NR NSA (EN-DC)
OVERRIDE_NETWORK_TYPE_NR_NSA_MMWAVE     = 4  // [已废弃] 5G 毫米波 NSA
OVERRIDE_NETWORK_TYPE_NR_ADVANCED      = 5  // 5G NR Advanced (5G+)
```

### 5.2 NSA 与 SA 场景差异

| 场景 | networkType | overrideNetworkType | 说明 |
|------|-------------|---------------------|------|
| 5G NSA (EN-DC) | `NETWORK_TYPE_LTE` (13) | `OVERRIDE_NETWORK_TYPE_NR_NSA` (3) | LTE 锚点 + NR 辅小区 |
| 5G NSA Advanced | `NETWORK_TYPE_LTE` (13) | `OVERRIDE_NETWORK_TYPE_NR_ADVANCED` (5) | LTE 锚点 + NR 高级 |
| 5G SA | `NETWORK_TYPE_NR` (20) | `OVERRIDE_NETWORK_TYPE_NONE` (0) | 纯 NR 驻留，无 override |
| 5G SA Advanced | `NETWORK_TYPE_NR` (20) | `OVERRIDE_NETWORK_TYPE_NR_ADVANCED` (5) | 纯 NR 驻留 + 高级 |

NSA 场景下 `networkType` 始终为 `LTE`，通过 `overrideNetworkType` 来指示 5G 状态；SA 场景下 `networkType` 直接为 `NR`。

---

## 第6章 SystemUI 图标显示流程

### 6.1 回调接收

`MobileStatusTracker` 内部的 `MobileTelephonyCallback` 实现了 `TelephonyCallback.DisplayInfoListener` 接口：

```java
// MobileStatusTracker.java:194-201
public void onDisplayInfoChanged(TelephonyDisplayInfo telephonyDisplayInfo) {
    mMobileStatus.telephonyDisplayInfo = telephonyDisplayInfo;
    mCallback.onMobileStatusChanged(
            /* updateTelephony= */ true, new MobileStatus(mMobileStatus));
}
```

回调触发后，`MobileSignalController.updateMobileStatus()` 更新当前状态，然后调用 `updateTelephony()`。

### 6.2 图标 Key 生成

`MobileSignalController.updateTelephony()` 是图标选择的核心方法：

```java
// MobileSignalController.java:478-527
private void updateTelephony() {
    // ...
    String iconKey = mMobileMappingsProxy.getIconKey(mCurrentState.telephonyDisplayInfo);
    if (mNetworkToIconLookup.get(iconKey) != null) {
        mCurrentState.iconGroup = mNetworkToIconLookup.get(iconKey);
    } else {
        mCurrentState.iconGroup = mDefaultIcons;
    }
    // ...
    notifyListenersIfNecessary();
}
```

`MobileMappings.getIconKey()` 根据是否设置了 `overrideNetworkType` 生成不同的 key：

```java
// MobileMappings.java:44-51
public static String getIconKey(TelephonyDisplayInfo telephonyDisplayInfo) {
    if (telephonyDisplayInfo.getOverrideNetworkType()
            == OVERRIDE_NETWORK_TYPE_NONE) {
        return toIconKey(telephonyDisplayInfo.getNetworkType());
    } else {
        return toDisplayIconKey(telephonyDisplayInfo.getOverrideNetworkType());
    }
}
```

### 6.3 Override Type 到 Icon Key 的映射

```java
// MobileMappings.java:63-76
public static String toDisplayIconKey(int displayNetworkType) {
    switch (displayNetworkType) {
        case OVERRIDE_NETWORK_TYPE_LTE_CA:
            return toIconKey(NETWORK_TYPE_LTE) + "_CA";           // "13_CA"
        case OVERRIDE_NETWORK_TYPE_LTE_ADVANCED_PRO:
            return toIconKey(NETWORK_TYPE_LTE) + "_CA_Plus";     // "13_CA_Plus"
        case OVERRIDE_NETWORK_TYPE_NR_NSA:
            return toIconKey(NETWORK_TYPE_NR);                     // "20"
        case OVERRIDE_NETWORK_TYPE_NR_ADVANCED:
            return toIconKey(NETWORK_TYPE_NR) + "_Plus";          // "20_Plus"
        default:
            return "unsupported";
    }
}
```

### 6.4 Icon Key 到 MobileIconGroup 的映射

```java
// MobileMappings.java:196-207
networkToIconLookup.put(toDisplayIconKey(OVERRIDE_NETWORK_TYPE_LTE_ADVANCED_PRO),
        TelephonyIcons.LTE_CA_5G_E);          // 5G E
networkToIconLookup.put(toDisplayIconKey(OVERRIDE_NETWORK_TYPE_NR_NSA),
        TelephonyIcons.NR_5G);                 // 5G
networkToIconLookup.put(toDisplayIconKey(OVERRIDE_NETWORK_TYPE_NR_ADVANCED),
        config.mobileIconGroup5gPlus);         // 5G+ (可被运营商配置覆盖)
networkToIconLookup.put(toIconKey(NETWORK_TYPE_NR),
        TelephonyIcons.NR_5G);                 // NR SA → 5G
```

### 6.5 图标资源获取

`MobileState.getNetworkTypeIcon()` 获取最终的 drawable 资源 ID：

```kotlin
// MobileState.kt:157
fun getNetworkTypeIcon(context: Context): Int {
    val icon = (iconGroup as MobileIconGroup)
    return networkTypeResIdCache.get(icon, carrierId, context)
}
```

通过 `NetworkTypeResIdCache` 缓存结果，并支持运营商自定义图标覆盖（`MobileIconCarrierIdOverrides`）。

### 6.6 UI 通知

`MobileSignalController.notifyListeners()` 构建包含 RAT 类型图标的 `MobileDataIndicators`，通过 `SignalCallback.setMobileDataIndicators()` 传递给 UI 层：

```java
// MobileSignalController.java:260-297
public void notifyListeners(SignalCallback callback) {
    MobileIconGroup icons = getIcons();
    int iconId = mCurrentState.getNetworkTypeIcon(mContext);
    // ...
    MobileDataIndicators mobileDataIndicators = new MobileDataIndicators(
            sbInfo.icon, qsInfo.icon,
            sbInfo.ratTypeIcon, qsInfo.ratTypeIcon,  // ★ RAT 类型图标
            // ...
    );
    callback.setMobileDataIndicators(mobileDataIndicators);
}
```

---

## 第7章 5G 图标判定规则汇总

### 7.1 OverrideNetworkType 到图标的映射

| OverrideNetworkType | 值 | Icon Key | MobileIconGroup | 状态栏图标 |
|---------------------|---|----------|-----------------|-----------|
| `OVERRIDE_NETWORK_TYPE_NR_NSA` | 3 | `"20"` | `NR_5G` | **5G** |
| `OVERRIDE_NETWORK_TYPE_NR_ADVANCED` | 5 | `"20_Plus"` | `NR_5G_PLUS` | **5G+** |
| `NETWORK_TYPE_NR` (SA, 无 override) | 20 | `"20"` | `NR_5G` | **5G** |
| `OVERRIDE_NETWORK_TYPE_LTE_ADVANCED_PRO` | 2 | `"13_CA_Plus"` | `LTE_CA_5G_E` | **5G E** |
| `OVERRIDE_NETWORK_TYPE_LTE_CA` | 1 | `"13_CA"` | `FOUR_G_LTE_PLUS` / `LTE_PLUS` | **LTE+** |

### 7.2 图标资源文件

所有 5G 相关图标资源位于 `base/packages/SettingsLib/res/drawable/`：

| 资源文件 | 说明 |
|---------|------|
| `ic_5g_mobiledata.xml` / `ic_5g_mobiledata_updated.xml` | 5G 图标（新旧两版） |
| `ic_5g_plus_mobiledata.xml` / `ic_5g_plus_mobiledata_updated.xml` | 5G+ 图标（新旧两版） |
| `ic_5g_e_mobiledata.xml` / `ic_5g_e_mobiledata_updated.xml` | 5G E 图标（新旧两版） |

每个图标都有新旧两套资源，通过 `Flags.newStatusBarIcons()` flag 切换。

---

## 第8章 关键源码文件索引

| 层级 | 文件路径 | 核心职责 |
|------|---------|---------|
| Telephony | `telephony/src/java/com/android/internal/telephony/NetworkTypeController.java` | 5G 图标决策状态机 |
| Telephony | `telephony/src/java/com/android/internal/telephony/DisplayInfoController.java` | TelephonyDisplayInfo 组装与广播 |
| Telephony | `telephony/src/java/com/android/internal/telephony/ServiceStateTracker.java` | NR 状态追踪与更新 |
| Telephony | `telephony/src/java/com/android/internal/telephony/DefaultPhoneNotifier.java` | 跨进程通知桥接 |
| Framework | `base/telephony/java/android/telephony/TelephonyDisplayInfo.java` | 显示信息数据结构 |
| Framework | `base/telephony/java/android/telephony/NetworkRegistrationInfo.java` | NR 状态定义 |
| Framework | `base/telephony/java/android/telephony/ServiceState.java` | 服务状态（含 getNrState） |
| SettingsLib | `base/packages/SettingsLib/src/com/android/settingslib/mobile/MobileMappings.java` | RAT 到图标的映射逻辑 |
| SettingsLib | `base/packages/SettingsLib/src/com/android/settingslib/mobile/TelephonyIcons.java` | 图标常量与 MobileIconGroup 定义 |
| SettingsLib | `base/packages/SettingsLib/src/com/android/settingslib/mobile/MobileStatusTracker.java` | TelephonyCallback 回调处理 |
| SystemUI | `base/packages/SystemUI/src/com/android/systemui/statusbar/connectivity/MobileSignalController.java` | 移动信号控制器（图标选择） |
| SystemUI | `base/packages/SystemUI/src/com/android/systemui/statusbar/connectivity/MobileState.kt` | 移动状态数据类 |
| SystemUI | `base/packages/SystemUI/src/com/android/systemui/statusbar/connectivity/SignalController.java` | 信号控制器基类 |
| SystemUI | `base/packages/SystemUI/src/com/android/systemui/statusbar/connectivity/NetworkControllerImpl.java` | 网络控制器（管理所有 MobileSignalController） |
