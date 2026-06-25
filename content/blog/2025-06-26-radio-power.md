---
title: "Android Radio 上下电全流程分析"
date: "2025-06-26"
summary: "从 ServiceStateTracker.setRadioPower() 入口开始，完整梳理 Android Radio 上下电控制链路：飞行模式开关、安全下电机制（powerOffRadioSafely）、多原因管理、紧急电话上电流程。"
category: "network-search"
tags: ["ServiceStateTracker", "RadioPower", "RIL", "Modem", "飞行模式", "EmergencyCall", "RadioOnHelper", "DataNetworkController", "PowerOffSafely"]
featured: true
---

> **文档定位**：基于 AOSP 源码，从 ServiceStateTracker.setRadioPower() 到 Modem 的完整 Radio 电源控制链路分析

## 第 1 章：概述

### 1.1 Radio 上下电是什么

Radio 上下电是指 Android 系统控制蜂窝调制解调器（Modem）电源状态的过程。**上电（Power On）** 使 Modem 进入工作状态，可以搜索网络、注册运营商、进行语音通话和数据连接；**下电（Power Off）** 则关闭 Modem 的射频功能，设备进入无蜂窝网络状态（如飞行模式）。

在 Android Telephony 架构中，Radio 电源管理的核心入口是 `ServiceStateTracker.setRadioPower()`，它协调了从 Framework 到 RIL 再到 Modem 的完整控制链路。

### 1.2 为什么需要"安全下电"

直接关闭 Radio 电源可能导致：
- 数据网络异常断开，TCP 连接非正常终止
- 正在进行的语音通话被强制挂断
- IMS 注册未正常注销，引发网络侧异常

因此，Android 设计了 **"先断数据、再关 Radio"** 的安全下电机制（`powerOffRadioSafely`），确保在关闭 Modem 之前：
1. 所有语音通话已正常挂断
2. 所有数据网络已优雅断开
3. IMS 注册已正常注销

### 1.3 整体流程总览

以飞行模式为例，Radio 上下电的完整生命周期如下：

```
飞行模式开启（下电）：
  用户点击开关 → 广播 ACTION_AIRPLANE_MODE_CHANGED
    → PhoneGlobals 接收广播
    → PhoneUtils.setRadioPower(false)
    → GsmCdmaPhone.setRadioPower
    → ServiceStateTracker.setRadioPowerForReason
    → setPowerStateToDesired（决策是否下电）
    → powerOffRadioSafely（安全下电）
    → 挂断语音通话 → 断开所有数据网络
    → hangupAndPowerOff
    → mCi.setRadioPower(false)
    → RIL_REQUEST_RADIO_POWER → Modem 下电
    → RIL_UNSOL_RESPONSE_RADIO_STATE_CHANGED（Modem 上报）

飞行模式关闭（上电）：
  用户点击开关 → 广播 ACTION_AIRPLANE_MODE_CHANGED
    → PhoneGlobals → PhoneUtils.setRadioPower(true)
    → ServiceStateTracker.setRadioPowerForReason
    → setPowerStateToDesired（决策是否上电）
    → mCi.setRadioPower(true)
    → RIL_REQUEST_RADIO_POWER → Modem 上电
    → Modem 搜网 → 注册网络
    → RIL_UNSOL_RESPONSE_RADIO_STATE_CHANGED（Modem 上报）
```

---

## 第 2 章：核心类与角色

### 2.1 ServiceStateTracker：状态管理与决策者

**文件**：ServiceStateTracker.java

`ServiceStateTracker` 是 Radio 电源管理的核心决策者，负责：

- **维护期望状态**：`mDesiredPowerState` 表示 Framework 期望的 Radio 电源状态
- **多原因管理**：`mRadioPowerOffReasons` 集合管理多个下电原因（USER / CARRIER / THERMAL 等），所有原因都清除后才会上电
- **决策执行**：`setPowerStateToDesired()` 根据当前状态和期望状态决定是否执行上下电
- **安全下电**：`powerOffRadioSafely()` 实现先断数据再关 Radio 的安全机制
- **监听数据断开**：通过 `mDataDisconnectedCallback` 监听数据网络断开事件

### 2.2 DataNetworkController：数据网络管家

**文件**：DataNetworkController.java

`DataNetworkController` 负责所有数据网络的建立、维护和断开，在 Radio 下电流程中：

- **判断连接状态**：`areAllDataDisconnected()` 判断所有（或仅蜂窝）数据网络是否已断开
- **断开数据网络**：`tearDownAllDataNetworks()` 主动断开所有数据网络
- **通知断开事件**：通过 `DataNetworkControllerCallback.onAnyDataNetworkExistingChanged()` 通知数据网络存在状态变化

### 2.3 RIL / BaseCommands：RIL 请求与状态维护

**文件**：
- RIL.java
- BaseCommands.java

`RIL`（Radio Interface Layer）是 Framework 与 Modem 通信的桥梁：

- **请求下发**：`setRadioPower()` 封装 `RIL_REQUEST_RADIO_POWER` 请求，通过 HAL 发送给 Modem
- **状态上报接收**：`RadioIndication.radioStateChanged()` 接收 Modem 侧的状态变化上报
- **状态维护**：`BaseCommands.setRadioState()` 维护当前 Radio 状态，并通过 Registrant 机制通知各监听者

Radio 状态有三种：
- `RADIO_POWER_OFF`：Radio 已关闭
- `RADIO_POWER_ON`：Radio 已开启
- `RADIO_POWER_UNAVAILABLE`：Radio 不可用（如 Modem 重启中）

### 2.4 RadioOnHelper / RadioOnStateListener：紧急上电辅助

**文件**：
- RadioOnHelper.java
- RadioOnStateListener.java

这两个类用于 **飞行模式下拨打紧急电话** 的场景：

- **`RadioOnHelper`**：多 SIM 维度的管理器，协调所有 Phone 的 Radio 上电流程
- **`RadioOnStateListener`**：单 Phone 维度的监听器，等待 Radio 就绪（监听 ServiceState、RadioOn、IMS、卫星状态等事件）

### 2.5 PhoneGlobals / PhoneUtils：飞行模式入口

**文件**：
- PhoneGlobals.java
- PhoneUtils.java

`PhoneGlobals` 是 TeleService 进程的全局管理类，负责：

- 接收 `ACTION_AIRPLANE_MODE_CHANGED` 广播
- 判断是否需要关闭蜂窝 Radio（`isRadioPowerOffDueToAirplaneMode`）
- 调用 `PhoneUtils.setRadioPower()` 执行操作

`PhoneUtils` 提供便捷方法，遍历所有 Phone 实例调用 `setRadioPower`。

---

## 第 3 章：RIL 消息交互

### 3.1 RIL_REQUEST_RADIO_POWER 请求

`RIL_REQUEST_RADIO_POWER` 是 Framework 向 Modem 发送的 Radio 电源控制请求。

**下发位置**：RIL.setRadioPower()

```java
public void setRadioPower(boolean on, boolean forEmergencyCall,
        boolean preferredForEmergencyCall, Message result) {
    RadioModemProxy modemProxy = getRadioServiceProxy(RadioModemProxy.class);
    if (!canMakeRequest("setRadioPower", modemProxy, result, RADIO_HAL_VERSION_1_4)) {
        return;
    }

    RILRequest rr = obtainRequest(RIL_REQUEST_RADIO_POWER, result, mRILDefaultWorkSource);

    radioServiceInvokeHelper(HAL_SERVICE_MODEM, rr, "setRadioPower", () -> {
        modemProxy.setRadioPower(rr.mSerial, on, forEmergencyCall,
                preferredForEmergencyCall);
    });
}
```

**参数说明**：
- `on`：true 表示上电，false 表示下电
- `forEmergencyCall`：是否为紧急电话而上电
- `preferredForEmergencyCall`：是否是紧急电话的首选 Phone
- `result`：回调消息，请求完成时通知

### 3.2 RIL_UNSOL_RESPONSE_RADIO_STATE_CHANGED 上报

`RIL_UNSOL_RESPONSE_RADIO_STATE_CHANGED` 是 Modem 主动上报的 Radio 状态变化消息。

**接收位置**：RadioIndication.radioStateChanged()

```java
public void radioStateChanged(int indicationType, int radioState) {
    mRil.processIndication(HAL_SERVICE_RADIO, indicationType);

    int state = RILUtils.convertHalRadioState(radioState);
    if (mRil.isLogOrTrace()) {
        mRil.unsljLogMore(
                RIL_UNSOL_RESPONSE_RADIO_STATE_CHANGED, "radioStateChanged: "
                        + RadioState.toString(radioState));
    }

    mRil.setRadioState(state, false /* forceNotifyRegistrants */);
}
```

**处理流程**：
1. HAL 层调用 `radioStateChanged` 传入新状态
2. 通过 `RILUtils.convertHalRadioState` 转换为 Framework 定义的状态常量
3. 调用 `BaseCommands.setRadioState()` 更新内部状态并通知监听者

### 3.3 Radio 状态机

**维护位置**：BaseCommands.setRadioState()

```java
protected void setRadioState(int newState, boolean forceNotifyRegistrants) {
    int oldState;

    synchronized (mStateMonitor) {
        oldState = mState;
        mState = newState;

        if (oldState == mState && !forceNotifyRegistrants) {
            return; // 状态未变化，不通知
        }

        mRadioStateChangedRegistrants.notifyRegistrants();

        // 各种状态转换的通知
        if (mState != RADIO_POWER_UNAVAILABLE && oldState == RADIO_POWER_UNAVAILABLE) {
            mAvailRegistrants.notifyRegistrants();
        }
        if (mState == RADIO_POWER_UNAVAILABLE && oldState != RADIO_POWER_UNAVAILABLE) {
            mNotAvailRegistrants.notifyRegistrants();
        }
        if (mState == RADIO_POWER_ON && oldState != RADIO_POWER_ON) {
            mOnRegistrants.notifyRegistrants();
        }
        if ((mState == RADIO_POWER_OFF || mState == RADIO_POWER_UNAVAILABLE)
                && oldState == RADIO_POWER_ON) {
            mOffOrNotAvailRegistrants.notifyRegistrants();
        }
    }
}
```

**状态转换与通知**：

| 转换方向 | 通知的 Registrant | 用途 |
|---------|------------------|------|
| 任意状态 → ON | `mOnRegistrants` | Radio 已开启时通知 |
| ON → OFF/UNAVAILABLE | `mOffOrNotAvailRegistrants` | Radio 已关闭时通知 |
| UNAVAILABLE → OFF/ON | `mAvailRegistrants` | Radio 从不可用变为可用 |
| OFF/ON → UNAVAILABLE | `mNotAvailRegistrants` | Radio 变为不可用 |
| 任意状态变化 | `mRadioStateChangedRegistrants` | 任何状态变化都通知 |

---

## 第 4 章：核心调用链 —— 从 setRadioPower 到 Modem

### 4.1 入口：setRadioPower → setRadioPowerForReason

#### 4.1.1 方法重载链

`setRadioPower` 有多个重载版本，最终都会调用到 `setRadioPowerForReason`：

**调用入口**：ServiceStateTracker.setRadioPower()

```
setRadioPower(boolean power)
  → setRadioPower(power, false, false, false)
    → setRadioPowerForReason(power, ..., RADIO_POWER_REASON_USER)
```

#### 4.1.2 mRadioPowerOffReasons 多原因管理机制

`mRadioPowerOffReasons` 是一个集合，用于记录所有导致 Radio 需要下电的原因。只有当所有原因都被清除时，Radio 才会上电。

**常见原因**：
- `RADIO_POWER_REASON_USER`：用户操作（如飞行模式）
- `RADIO_POWER_REASON_CARRIER`：运营商策略
- `RADIO_POWER_REASON_THERMAL`：热保护

**核心逻辑**：

```java
public void setRadioPowerForReason(boolean power, boolean forEmergencyCall,
        boolean isSelectedPhoneForEmergencyCall, boolean forceApply, int reason) {

    if (power) {
        if (forEmergencyCall) {
            clearAllRadioOffReasons();  // 紧急电话：清除所有原因
        } else {
            mRadioPowerOffReasons.remove(reason);  // 仅移除指定原因
        }
    } else {
        mRadioPowerOffReasons.add(reason);  // 下电：添加原因
    }

    // 如果状态未变且不强制应用，直接返回
    if (power == mDesiredPowerState && !forceApply) {
        return;
    }

    // 如果要上电，但仍有其他下电原因，不上电
    if (power && !mRadioPowerOffReasons.isEmpty()) {
        return;
    }

    mDesiredPowerState = power;
    setPowerStateToDesired(forEmergencyCall, isSelectedPhoneForEmergencyCall, forceApply);
}
```

**关键点**：
- 下电时添加原因，上电时移除原因
- 紧急电话场景会清除所有下电原因（`clearAllRadioOffReasons`），确保立即上电
- 即使期望上电，如果仍有其他原因（如热保护），也不会真正上电

#### 4.1.3 GsmCdmaPhone 层封装

**位置**：GsmCdmaPhone.setRadioPowerForReason()

`GsmCdmaPhone` 作为 Phone 接口的实现，将调用转发给 `ServiceStateTracker`。如果调用来自 Binder 线程，会 post 到主线程执行。

### 4.2 决策：setPowerStateToDesired

`setPowerStateToDesired` 是 Radio 电源状态的核心决策方法，根据当前状态和期望状态决定执行什么操作。

**位置**：ServiceStateTracker.setPowerStateToDesired()

```java
protected void setPowerStateToDesired(boolean forEmergencyCall,
        boolean isSelectedPhoneForEmergencyCall, boolean forceApply) {

    // 设备正在关机时，不上电
    if (mDesiredPowerState && mDeviceShuttingDown) {
        return;
    }

    // 条件 1：期望上电 + 无下电原因 + 当前是 OFF/UNAVAILABLE → 上电
    if (mDesiredPowerState && mRadioPowerOffReasons.isEmpty()
            && (forceApply || mCi.getRadioState() == TelephonyManager.RADIO_POWER_OFF
                 || mCi.getRadioState() == TelephonyManager.RADIO_POWER_UNAVAILABLE)) {
        mCi.setRadioPower(true, forEmergencyCall, isSelectedPhoneForEmergencyCall, null);
    }
    // 条件 2：期望下电（或有下电原因）+ 当前是 ON → 安全下电
    else if ((!mDesiredPowerState || !mRadioPowerOffReasons.isEmpty())
            && mCi.getRadioState() == TelephonyManager.RADIO_POWER_ON) {
        powerOffRadioSafely();
    }
    // 条件 3：设备正在关机 + Radio 不是不可用 → 请求关机
    else if (mDeviceShuttingDown
            && (mCi.getRadioState() != TelephonyManager.RADIO_POWER_UNAVAILABLE)) {
        mCi.requestShutdown(null);
    }
}
```

**三条执行路径**：

| 条件 | 操作 | 说明 |
|------|------|------|
| 期望上电 + 无原因 + 当前 OFF/UNAVAILABLE | `mCi.setRadioPower(true)` | 正常上电 |
| 期望下电（或有原因）+ 当前 ON | `powerOffRadioSafely()` | 安全下电（先断数据） |
| 设备关机 + Radio 可用 | `mCi.requestShutdown()` | Modem 关机流程 |

### 4.3 安全下电：powerOffRadioSafely

`powerOffRadioSafely` 实现了"先断数据、再关 Radio"的安全下电机制。

**位置**：ServiceStateTracker.powerOffRadioSafely()

#### 4.3.1 执行步骤

1. **挂断语音通话**：先挂断所有活跃的语音通话（RingingCall / BackgroundCall / ForegroundCall）
2. **检查数据连接**：遍历所有 Phone，检查数据是否已全部断开
3. **注册监听**：如果有数据未断开，注册 `mDataDisconnectedCallback` 监听断开事件
4. **主动断开数据**：调用 `tearDownAllDataNetworks()` 主动断开所有数据网络
5. **分情况处理**：
   - 数据已全部断开 → 直接 `hangupAndPowerOff()`
   - 数据未断开 → 等待回调，同时启动超时兜底

#### 4.3.2 keepWfcOnApm 特性分支

代码中有两条路径，由 `mFeatureFlags.keepWfcOnApm()` 控制：

| 路径 | 变量 | 说明 |
|------|------|------|
| keepWfcOnApm = true | `mPendingRadioPowerOffReason` | 保留 WFC（Wi-Fi Calling），仅断开蜂窝数据 |
| keepWfcOnApm = false | `mPendingRadioPowerOffAfterDataOff` | 断开所有数据网络 |

**WFC 保留逻辑**：
- `cellularOnly` 参数控制 `areAllDataDisconnected` 是否只检查蜂窝数据
- 飞行模式下如果开启了 WFC，可以保留 Wi-Fi 通话能力，只关闭蜂窝 Radio

### 4.4 最终下电：hangupAndPowerOff

当所有数据都断开后，调用 `hangupAndPowerOff` 执行最终的 Radio 下电。

**位置**：ServiceStateTracker.hangupAndPowerOff()

```java
protected void hangupAndPowerOff() {
    if (mCi.getRadioState() == TelephonyManager.RADIO_POWER_OFF) return;

    // 再次挂断所有语音通话（确保万无一失）
    if (mPhone.isInCall()) {
        mPhone.mCT.mRingingCall.hangupIfAlive();
        mPhone.mCT.mBackgroundCall.hangupIfAlive();
        mPhone.mCT.mForegroundCall.hangupIfAlive();
    }

    mCi.setRadioPower(false, obtainMessage(EVENT_RADIO_POWER_OFF_DONE));
}
```

---

## 第 5 章：数据断开分界点详解

### 5.1 areAllDataDisconnected 判断逻辑

`areAllDataDisconnected` 用于判断数据网络是否已全部断开，是安全下电的核心判断条件。

**位置**：DataNetworkController.areAllDataDisconnected()

```java
public boolean areAllDataDisconnected(boolean cellularOnly) {
    if (mFeatureFlags.keepWfcOnApm() && cellularOnly) {
        List<DataNetwork> cellularNetworks = getCellularDataNetworks();
        if (!cellularNetworks.isEmpty()) {
            log("areAllCellularDataDisconnected false due to: "
                    + cellularNetworks.stream().map(DataNetwork::name)
                    .collect(Collectors.joining(", ")));
        }
        return cellularNetworks.isEmpty();
    } else {
        if (!mDataNetworkList.isEmpty()) {
            log("areAllDataDisconnected false due to: "
                    + mDataNetworkList.stream().map(DataNetwork::name)
                    .collect(Collectors.joining(", ")));
        }
        return mDataNetworkList.isEmpty();
    }
}
```

**参数说明**：
- `cellularOnly`：是否只检查蜂窝数据网络（true 时忽略 WFC 等 IWLAN 数据）
- 当 `keepWfcOnApm` 启用且 `cellularOnly=true` 时，只检查蜂窝数据，保留 Wi-Fi Calling 能力

### 5.2 tearDownAllDataNetworks 执行

`tearDownAllDataNetworks` 主动断开所有数据网络，是安全下电的必要步骤。

**位置**：DataNetworkController.tearDownAllDataNetworks()

```java
public void tearDownAllDataNetworks(@TearDownReason int reason) {
    sendMessage(obtainMessage(EVENT_TEAR_DOWN_ALL_DATA_NETWORKS, reason, 0));
}

private void onTearDownAllDataNetworks(@TearDownReason int reason) {
    if (mDataNetworkList.isEmpty()) {
        return;
    }

    // 飞行模式 + keepWfcOnApm → 只断开蜂窝数据
    List<DataNetwork> dataNetworks = mFeatureFlags.keepWfcOnApm()
            && reason == DataNetwork.TEAR_DOWN_REASON_AIRPLANE_MODE_ON
            ? getCellularDataNetworks() : mDataNetworkList;

    for (DataNetwork dataNetwork : dataNetworks) {
        if (!dataNetwork.isDisconnecting()) {
            tearDownGracefully(dataNetwork, reason);
        }
    }
}
```

**关键逻辑**：
- 通过 `EVENT_TEAR_DOWN_ALL_DATA_NETWORKS` 消息切换到 DataNetworkController 线程执行
- 飞行模式且启用 WFC 保留时，只断开蜂窝数据网络
- 对每个数据网络调用 `tearDownGracefully()` 进行优雅断开（先去激活，再清理）

### 5.3 断开回调链路

#### 5.3.1 数据网络存在状态变化通知

当数据网络的存在状态变化时（从有到无，或从无到有），`DataNetworkController` 通过 `DataNetworkControllerCallback` 通知所有注册者。

**位置**：DataNetworkController.updateCellularDataNetworkExistence()

```java
private void updateCellularDataNetworkExistence(boolean anyDataNetworkExisting,
        boolean anyCellularNetworkExists) {
    if (anyDataNetworkExisting != mAnyDataNetworkExisting
            || anyCellularNetworkExists != mAnyCellularDataNetworkExisting) {
        mAnyDataNetworkExisting = anyDataNetworkExisting;
        mAnyCellularDataNetworkExisting = anyCellularNetworkExists;
        mDataNetworkControllerCallbacks.forEach(callback -> callback.invokeFromExecutor(
                () -> callback.onAnyDataNetworkExistingChanged(mAnyDataNetworkExisting,
                        mAnyCellularDataNetworkExisting)));
    }
}
```

#### 5.3.2 ServiceStateTracker 侧的回调处理

`ServiceStateTracker` 在 `powerOffRadioSafely` 中注册 `mDataDisconnectedCallback` 监听断开事件。

**位置**：ServiceStateTracker.mDataDisconnectedCallback

```java
mDataDisconnectedCallback = new DataNetworkControllerCallback(this::post) {
    @Override
    public void onAnyDataNetworkExistingChanged(boolean anyDataExisting,
            boolean anyCellularDataExisting) {
        log("onAnyDataNetworkExistingChanged: anyData=" + anyDataExisting
                + " anyCellularData=" + anyCellularDataExisting);
        if (!anyDataExisting
                || mFeatureFlags.keepWfcOnApm()
                && !mDeviceShuttingDown && !anyCellularDataExisting) {
            sendEmptyMessage(EVENT_ALL_DATA_DISCONNECTED);
        }
    }
};
```

**触发条件**（满足任一即可）：
- 所有数据网络都已断开（`!anyDataExisting`）
- 启用 WFC 保留且非关机场景下，所有蜂窝数据已断开（`!anyCellularDataExisting`）

#### 5.3.3 EVENT_ALL_DATA_DISCONNECTED 消息处理

收到 `EVENT_ALL_DATA_DISCONNECTED` 后，需要检查**所有 Phone** 的数据是否都断开了，确保多 SIM 场景下全局一致。

**位置**：ServiceStateTracker.handleMessage EVENT_ALL_DATA_DISCONNECTED

```java
case EVENT_ALL_DATA_DISCONNECTED:
    synchronized (this) {
        // 检查是否真的有待处理的下电请求
        if (mFeatureFlags.keepWfcOnApm()) {
            if (mPendingRadioPowerOffReason == DataNetwork.TEAR_DOWN_REASON_NONE) {
                return;
            }
        } else if (!mPendingRadioPowerOffAfterDataOff) {
            return;
        }

        // 检查所有 Phone 的数据是否都断开了
        boolean areAllDataDisconnectedOnAllPhones = true;
        for (Phone phone : PhoneFactory.getPhones()) {
            if (phone.getDataNetworkController()
                    .areAllDataDisconnected(!mDeviceShuttingDown/*cellularOnly*/)) {
                phone.getDataNetworkController()
                    .unregisterDataNetworkControllerCallback(mDataDisconnectedCallback);
            } else {
                areAllDataDisconnectedOnAllPhones = false;
            }
        }

        if (areAllDataDisconnectedOnAllPhones) {
            // 全部断开，清除状态，关 Radio
            removeMessages(EVENT_SET_RADIO_POWER_OFF);
            hangupAndPowerOff();
        }
    }
    break;
```

**多 SIM 全局检查**：
- 遍历所有 Phone，检查每个 Phone 的数据是否都断开
- 对已断开的 Phone 注销回调
- 只有所有 Phone 都断开了，才执行 `hangupAndPowerOff()`

#### 5.3.4 超时兜底机制

为防止数据网络因异常无法断开导致 Radio 无法关闭，设置了超时兜底。

在 `powerOffRadioSafely` 中，如果有数据未断开，会发送延迟消息：

```java
sendEmptyMessageDelayed(EVENT_SET_RADIO_POWER_OFF,
        POWER_OFF_ALL_DATA_NETWORKS_DISCONNECTED_TIMEOUT);
```

超时后，即使数据未完全断开，也会强制关闭 Radio，避免卡死。

---

## 第 6 章：飞行模式全流程

### 6.1 飞行模式开启（Radio 下电）

#### 6.1.1 触发入口：Settings → 广播

用户在设置中开启飞行模式后，系统发送 `ACTION_AIRPLANE_MODE_CHANGED` 广播。

#### 6.1.2 PhoneGlobals 处理

**位置**：PhoneGlobals.handleAirplaneModeChange()

```java
// 注册广播接收器
IntentFilter filter = new IntentFilter();
filter.addAction(Intent.ACTION_AIRPLANE_MODE_CHANGED);
registerReceiver(mReceiver, filter);

// 处理广播
if (action.equals(Intent.ACTION_AIRPLANE_MODE_CHANGED)) {
    boolean airplaneMode = intent.getBooleanExtra("state", false);
    handleAirplaneModeChange(airplaneMode);
}
```

#### 6.1.3 handleAirplaneModeChange 逻辑

```java
private void handleAirplaneModeChange(boolean airplaneMode) {
    if (airplaneMode) {
        // 飞行模式开启
        // 紧急电话进行中时忽略
        if (isThereAnyEmergencyCall()) {
            // 切换回关闭状态
            setRadioPowerOn();
            return;
        }

        // 检查设置是否允许关闭蜂窝 Radio
        if (isRadioPowerOffDueToAirplaneMode()) {
            setRadioPowerOff();
        }
    } else {
        // 飞行模式关闭
        setRadioPowerOn();
    }
}
```

**判断是否需要关闭蜂窝 Radio**：
`isRadioPowerOffDueToAirplaneMode()` 检查 `Settings.Global.AIRPLANE_MODE_RADIOS` 是否包含 `RADIO_CELL`，如果包含则关闭蜂窝 Radio。

#### 6.1.4 setRadioPowerOff 与 setRadioPowerOn

```java
private void setRadioPowerOff() {
    TelephonyProperties.airplane_mode_on(true);
    PhoneUtils.setRadioPower(false);
}

private void setRadioPowerOn() {
    TelephonyProperties.airplane_mode_on(false);
    PhoneUtils.setRadioPower(true);
}
```

`PhoneUtils.setRadioPower()` 遍历所有 Phone 调用 `setRadioPower`。

#### 6.1.5 飞行模式开启全链路时序

```
用户点击飞行模式开关
  ↓
Settings.Global.AIRPLANE_MODE_ON = 1
  ↓
发送 ACTION_AIRPLANE_MODE_CHANGED 广播
  ↓
PhoneGlobals.mReceiver 接收
  ↓
handleAirplaneModeChange(true)
  ↓
isRadioPowerOffDueToAirplaneMode() → true
  ↓
setRadioPowerOff()
  ↓
PhoneUtils.setRadioPower(false)
  ↓
遍历所有 Phone → phone.setRadioPower(false)
  ↓
GsmCdmaPhone.setRadioPower
  ↓
ServiceStateTracker.setRadioPowerForReason
    ↓ 添加 RADIO_POWER_REASON_USER
    ↓ mDesiredPowerState = false
    ↓ setPowerStateToDesired()
    ↓
    Radio 状态是 ON → powerOffRadioSafely()
    ↓
    挂断语音通话 → 检查数据连接
    ↓
    有数据连接 → 注册回调 → tearDownAllDataNetworks
    ↓ （等待数据断开）
    数据断开 → EVENT_ALL_DATA_DISCONNECTED
    ↓
    hangupAndPowerOff()
    ↓
    mCi.setRadioPower(false)
    ↓
    RIL_REQUEST_RADIO_POWER → Modem
    ↓
Modem 下电完成 → RIL_UNSOL_RESPONSE_RADIO_STATE_CHANGED
  ↓
RadioIndication.radioStateChanged()
  ↓
BaseCommands.setRadioState(RADIO_POWER_OFF)
  ↓
mOffOrNotAvailRegistrants.notifyRegistrants()
```

### 6.2 飞行模式关闭（Radio 上电）

#### 6.2.1 上电路径

飞行模式关闭的流程相对简单，因为不需要安全下电那些步骤：

```
用户关闭飞行模式
  ↓
ACTION_AIRPLANE_MODE_CHANGED(state=false)
  ↓
PhoneGlobals.handleAirplaneModeChange(false)
  ↓
setRadioPowerOn()
  ↓
PhoneUtils.setRadioPower(true)
  ↓
遍历所有 Phone → phone.setRadioPower(true)
  ↓
ServiceStateTracker.setRadioPowerForReason
    ↓ 移除 RADIO_POWER_REASON_USER
    ↓ mRadioPowerOffReasons 为空
    ↓ mDesiredPowerState = true
    ↓ setPowerStateToDesired()
    ↓
    Radio 是 OFF/UNAVAILABLE → mCi.setRadioPower(true)
    ↓
    RIL_REQUEST_RADIO_POWER → Modem
    ↓
Modem 上电 → 开始搜网
  ↓
RIL_UNSOL_RESPONSE_RADIO_STATE_CHANGED(ON)
  ↓
BaseCommands.setRadioState(RADIO_POWER_ON)
  ↓
mOnRegistrants.notifyRegistrants()
  ↓
网络注册完成 → ServiceState 更新为 IN_SERVICE
```

#### 6.2.2 上电后的搜网流程

Radio 上电后，Modem 会自动开始搜索网络并尝试注册。注册成功后：
- `RIL_UNSOL_RESPONSE_NETWORK_STATE_CHANGED` 上报网络状态变化
- `ServiceStateTracker` 处理并更新 `ServiceState`
- 服务状态从 `STATE_OUT_OF_SERVICE` 变为 `STATE_IN_SERVICE`

### 6.3 启动时初始状态

`ServiceStateTracker` 在构造函数中读取系统设置，决定初始 Radio 电源状态。

**位置**：ServiceStateTracker 构造函数

```java
// system setting property AIRPLANE_MODE_ON is set in Settings.
int airplaneMode = Settings.Global.getInt(mCr, Settings.Global.AIRPLANE_MODE_ON, 0);
int enableCellularOnBoot = Settings.Global.getInt(mCr,
        Settings.Global.ENABLE_CELLULAR_ON_BOOT, getDefaultEnableCellularOnBoot());
mDesiredPowerState = (enableCellularOnBoot > 0) && ! (airplaneMode > 0);
if (!mDesiredPowerState) {
    mRadioPowerOffReasons.add(TelephonyManager.RADIO_POWER_REASON_USER);
}
```

**初始状态逻辑**：
- 读取 `AIRPLANE_MODE_ON` 判断是否开启飞行模式
- 读取 `ENABLE_CELLULAR_ON_BOOT` 判断是否允许启动时启用蜂窝
- 两者都满足时，初始期望状态为上电
- 否则初始为下电，并添加 `RADIO_POWER_REASON_USER` 原因

---

## 第 7 章：典型场景分析

### 7.1 用户主动操作飞行模式开关

**触发方式**：用户在设置中点击飞行模式开关

**完整流程**：参见第 6 章"飞行模式全流程"

**关键特点**：
- 由 `ACTION_AIRPLANE_MODE_CHANGED` 广播驱动
- 下电原因是 `RADIO_POWER_REASON_USER`
- 下电走 `powerOffRadioSafely` 安全流程
- 上电时如果有其他下电原因（如热保护），可能不会真正上电

### 7.2 Modem 主动上报 Radio 状态变化

**触发方式**：Modem 侧因各种原因（如异常重启、网络侧命令等）主动改变 Radio 状态

**处理流程**：

```
Modem 状态变化
  ↓
HAL radioStateChanged 回调
  ↓
RadioIndication.radioStateChanged()
  ↓
RILUtils.convertHalRadioState() 转换状态值
  ↓
BaseCommands.setRadioState(newState)
  ↓
状态变化？→ mRadioStateChangedRegistrants.notifyRegistrants()
  ↓
根据转换方向分别通知：
  - → ON：mOnRegistrants
  - ON → OFF/UNAVAILABLE：mOffOrNotAvailRegistrants
  - UNAVAILABLE → 其他：mAvailRegistrants
  - 其他 → UNAVAILABLE：mNotAvailRegistrants
```

**常见场景**：
- Modem 异常重启：Radio 状态从 ON → UNAVAILABLE → ON
- 网络侧去激活：可能导致 Radio 状态变化
- AT 命令或其他调试手段触发的状态变化

**ServiceStateTracker 的处理**：
`ServiceStateTracker` 注册了 `registerForRadioStateChanged`，会在状态变化时收到 `EVENT_RADIO_STATE_CHANGED` 消息，并触发 `pollState` 等操作更新服务状态。

### 7.3 飞行模式拨打紧急电话

这是最复杂的 Radio 上电场景之一。在飞行模式下，用户拨打紧急电话，需要先打开 Radio，等待 Radio 就绪后再发起呼叫。

#### 7.3.1 触发入口：TelephonyConnectionService

**位置**：TelephonyConnectionService.java

当 `TelephonyConnectionService` 收到紧急电话请求且 Radio 已关闭时，会调用 `RadioOnHelper` 来上电。

```java
// 飞行模式下拨打电话
curPhone.setRadioPower(true, false, false, true);
```

#### 7.3.2 RadioOnHelper 协调流程

**位置**：RadioOnHelper.triggerRadioOnAndListen()

```java
public void triggerRadioOnAndListen(RadioOnStateListener.Callback callback,
        boolean forEmergencyCall, Phone phoneForEmergencyCall, boolean isTestEmergencyNumber,
        int emergencyTimeoutIntervalMillis) {
    setupListeners();  // 根据活动 Modem 数量创建监听器
    mCallback = callback;
    mInProgressListeners.clear();
    mIsRadioReady = false;

    // 为每个 Phone 启动等待流程
    for (int i = 0; i < TelephonyManager.from(mContext).getActiveModemCount(); i++) {
        Phone phone = PhoneFactory.getPhone(i);
        // ...
        mInProgressListeners.add(mListeners.get(i));
        mListeners.get(i).waitForRadioOn(phone, this, forEmergencyCall,
                forEmergencyCall && phone == phoneForEmergencyCall,
                timeoutCallbackInterval);
    }

    powerOnRadio(forEmergencyCall, phoneForEmergencyCall, isTestEmergencyNumber);

    // 如果卫星已启用，关闭卫星 Modem
    if (SatelliteController.getInstance().isSatelliteEnabledOrBeingEnabled()) {
        powerOffSatellite();
    }
}
```

**执行步骤**：
1. 为每个活动 Modem 创建/复用 `RadioOnStateListener`
2. 所有监听器开始等待 Radio 就绪
3. 调用 `powerOnRadio()` 给所有 Phone 上电
4. 如果卫星 Modem 已启用，关闭卫星 Modem（为紧急电话让道）

#### 7.3.3 powerOnRadio 上电并同步设置

**位置**：RadioOnHelper.powerOnRadio()

```java
private void powerOnRadio(boolean forEmergencyCall, Phone phoneForEmergencyCall,
        boolean isTestEmergencyNumber) {
    // 给所有 Phone 上电
    for (Phone phone : PhoneFactory.getPhones()) {
        if (isTestEmergencyNumber) {
            phone.setRadioPowerOnForTestEmergencyCall(phone == phoneForEmergencyCall);
        } else {
            phone.setRadioPower(true, forEmergencyCall, phone == phoneForEmergencyCall, false);
        }
    }

    // 如果飞行模式开启，同步关闭飞行模式设置
    if (Settings.Global.getInt(mContext.getContentResolver(),
            Settings.Global.AIRPLANE_MODE_ON, 0) > 0) {
        Settings.Global.putInt(mContext.getContentResolver(),
                Settings.Global.AIRPLANE_MODE_ON, 0);

        // 发送广播保持状态一致
        Intent intent = new Intent(Intent.ACTION_AIRPLANE_MODE_CHANGED);
        intent.putExtra("state", false);
        mContext.sendBroadcastAsUser(intent, UserHandle.ALL);
    }
}
```

**关键点**：
- 紧急电话场景下，`setRadioPower` 会清除所有下电原因（`clearAllRadioOffReasons`），确保立即上电
- 如果飞行模式是开启的，会自动关闭飞行模式设置并发送广播，保持系统状态一致

#### 7.3.4 RadioOnStateListener 等待就绪

**位置**：RadioOnStateListener

`RadioOnStateListener` 监听多个事件来判断 Radio 是否就绪：

| 监听事件 | 消息 | 说明 |
|---------|------|------|
| ServiceState 变化 | `MSG_SERVICE_STATE_CHANGED` | 服务状态变为可用 |
| Radio On | `MSG_RADIO_ON` | Radio 已上电 |
| Radio Off | `MSG_RADIO_OFF_OR_NOT_AVAILABLE` | Radio 又关了，重新注册 |
| IMS 能力变化 | `MSG_IMS_CAPABILITY_CHANGED` | IMS 语音能力就绪 |
| 卫星状态变化 | `MSG_SATELLITE_ENABLED_CHANGED` | 卫星 Modem 已关闭 |
| 重试超时 | `MSG_RETRY_TIMEOUT` | 长时间无响应，重试 |
| 超时回调 | `MSG_TIMEOUT_ONTIMEOUT_CALLBACK` | 定时检查是否可拨打 |

**判断是否可拨打**：通过 `Callback.isOkToCall()` 回调由调用方判断当前状态是否满足拨打条件。

#### 7.3.5 重试与超时机制

- **重试**：`MSG_RETRY_TIMEOUT`（默认 5 秒）触发后，如果 Radio 仍未就绪，再次尝试上电
- **最大重试次数**：`MAX_NUM_RETRIES = 5` 次
- **超时回调**：`MSG_TIMEOUT_ONTIMEOUT_CALLBACK` 按指定间隔调用 `Callback.onTimeout()`，由调用方决定是否认为就绪
- **所有监听器完成**：`RadioOnHelper.onComplete()` 汇总所有 Phone 的结果，最终通知调用方

### 7.4 数据自愈（简要说明）

**触发方式**：数据网络连接异常时，`DataStallRecoveryManager` 尝试恢复数据连接

**与 Radio 的关系**：
- 在某些数据恢复策略中，可能会涉及 Radio 状态的切换（如重启 Radio）
- `DataStallRecoveryManager` 检测到数据长期无响应时，可能触发更激进的恢复手段
- 具体实现取决于设备的 carrier 配置和 recovery 策略

**文件**：DataStallRecoveryManager.java

---

## 第 8 章：调试与日志

### 8.1 关键 Log TAG

| TAG | 类 | 关注点 |
|-----|----|--------|
| `ServiceStateTracker` | ServiceStateTracker | Radio 电源决策、安全下电、数据断开回调 |
| `RILJ` | RIL | RIL 请求下发、Radio 状态变化 |
| `RadioOnStateListener` | RadioOnHelper/Listener | 紧急电话上电流程 |
| `DataNetworkController` | DataNetworkController | 数据网络断开、tear down |
| `PhoneGlobals` | PhoneGlobals | 飞行模式广播处理 |
| `RadioIndication` | RadioIndication | HAL 侧上报处理 |

### 8.2 常用过滤命令

```bash
# 查看 Radio 电源相关日志
adb logcat -b radio | grep -E "setRadioPower|powerOffRadioSafely|setPowerStateToDesired|mDesiredPowerState|mRadioPowerOffReasons"

# 查看数据断开相关日志
adb logcat -b radio | grep -E "onAnyDataNetworkExistingChanged|EVENT_ALL_DATA_DISCONNECTED|areAllDataDisconnected|tearDownAllDataNetworks"

# 查看 RIL Radio Power 请求
adb logcat -b radio | grep -E "RIL_REQUEST_RADIO_POWER|RADIO_STATE_CHANGED|setRadioState"

# 查看飞行模式处理
adb logcat -b all | grep -E "AIRPLANE_MODE|airplaneMode"

# 查看紧急电话上电流程
adb logcat -b radio | grep -E "RadioOnStateListener|triggerRadioOnAndListen|waitForRadioOn"
```

### 8.3 dumpsys 调试

```bash
# 查看 Telephony 服务信息
adb shell dumpsys telephony.registry

# 查看数据网络状态
adb shell dumpsys telephony.data
```

### 8.4 常见问题排查思路

**问题 1：飞行模式下 Radio 关不掉**
- 检查 `mRadioPowerOffReasons` 是否为空（为空说明没有下电原因）
- 检查数据网络是否长时间无法断开（查看超时兜底是否触发）
- 查看 `RIL_REQUEST_RADIO_POWER` 是否下发成功

**问题 2：飞行模式关闭后 Radio 不上电**
- 检查 `mRadioPowerOffReasons` 是否还有其他原因（如热保护）
- 检查 `mDesiredPowerState` 是否为 true
- 查看 `setPowerStateToDesired` 的日志，判断卡在哪条分支

**问题 3：安全下电超时**
- 检查 `areAllDataDisconnected` 返回 false 的原因（哪个数据网络未断开）
- 查看 `tearDownAllDataNetworks` 是否正常执行
- 检查超时时间配置 `POWER_OFF_ALL_DATA_NETWORKS_DISCONNECTED_TIMEOUT`

**问题 4：紧急电话时 Radio 上电慢**
- 查看 `RadioOnStateListener` 的日志，判断卡在哪个事件
- 检查卫星 Modem 是否需要关闭（可能等待卫星关闭耗时）
- 查看 IMS 注册状态是否影响了就绪判断
