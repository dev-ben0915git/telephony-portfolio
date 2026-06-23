---
title: "Android 开机驻网全流程梳理"
date: "2025-06-22"
summary: "从 Phone 进程启动到 ServiceState 广播通知，完整梳理 Android 开机驻网的 6 个关键阶段：SST 初始化、NRM 初始化、服务绑定、状态监听、驻网查询与状态更新。"
category: "network-search"
tags: ["搜网", "驻网", "ServiceStateTracker", "NetworkRegistrationManager", "RIL", "Telephony"]
featured: true
---

## 一、驻网流程总览

Android 开机驻网是一个从 Framework 到 RIL 再到 Modem 的完整链路过程。本文按照代码执行顺序，梳理从 Phone 进程拉起到最终广播 ServiceState 变化的 6 个关键阶段。

## 二、ServiceStateTracker 初始化

开机时 AMS 会拉起各种常驻进程，Phone 进程随之启动。初始化链路如下：

```
PhoneApp → PhoneGlobals → PhoneFactory → GsmCdmaPhone → ServiceStateTracker
```

PhoneFactory 负责构造 Phone 实例，在创建 GsmCdmaPhone 的过程中会构造 ServiceStateTracker（以下简称 SST），SST 是 Framework 层网络状态管理的核心类。

> **[流程图]** Phone 进程初始化调用链：PhoneApp → PhoneGlobals → PhoneFactory.makePhone() → GsmCdmaPhone 构造 → new ServiceStateTracker()

## 三、NetworkRegistrationManager 初始化

SST 初始化时，会根据获取到的 Transport 类型（WWAN、WLAN）分别初始化对应的 NetworkRegistrationManager（以下简称 NRM）。

> **[流程图]** ServiceStateTracker 根据 Transport（WWAN / WLAN）分别创建 NetworkRegistrationManager 实例

NRM 负责管理特定传输类型下的网络注册状态，是 Android 网络注册架构中 Transport 分层设计的关键组件。

## 四、绑定 CellularNetworkService 服务

CellularNetworkService 继承了 NetworkService。当 NRM 初始化完成后，会发送 Message 尝试绑定 NetworkService，对应的 package 是 `com.android.phone`，即蜂窝网络服务。

绑定使用 `context.bindService()` 方法，需要等待 `onServiceConnected` 回调之后才算真正绑定连接成功。

> **注意**：从多个项目经验上看，`onServiceConnected` 回调时机是中低端机或 CPU 高负载场景下开机驻网慢的原因之一。PhoneFactory 构造完 Phone 的流程走完之后才会回调 `onServiceConnected`，如果系统负载高，这个等待时间会被拉长。

> **[流程图]** NetworkRegistrationManager 通过 context.bindService() 绑定 CellularNetworkService

## 五、服务状态注册监听

SST 和 NRM 都进行了服务状态注册监听。核心链路最终到达 `CellularNetworkServiceProvider` 初始化时，会调用：

```java
mPhone.mCi.registerForNetworkStateChanged(...)
```

最终监听底层服务状态变化。

> **[流程图]** CellularNetworkServiceProvider 初始化时注册监听 mPhone.mCi.registerForNetworkStateChanged

## 六、Modem 主动上报消息触发驻网查询

底层服务状态变化通过异步 RegistrantList 消息机制传递交互。

当 Modem 网络状态发生变化时，会主动上报 `UNSOL_RESPONSE_NETWORK_STATE_CHANGED` unsol 消息，通知到 CellularNetworkService，然后层层传递到 ServiceStateTracker。

当 SST 收到 `EVENT_NETWORK_STATE_CHANGED` 消息时，执行 `pollStateInternal()` 方法触发驻网查询。

> **[流程图]** Modem → UNSOL_RESPONSE_NETWORK_STATE_CHANGED → CellularNetworkService → ServiceStateTracker → pollStateInternal()

## 七、驻网查询（pollStateInternal）

`pollStateInternal` 是驻网查询的核心方法，执行逻辑如下：

1. **检查 Radio 状态**：如果 Radio 不可用（`RADIO_POWER_UNAVAILABLE`）或下电（`RADIO_POWER_OFF`），不会触发查询
2. **Radio 上电时发起 5 个并行请求**：

| 请求 | Transport | Domain | 说明 |
|------|----------|--------|------|
| `getOperator` | - | - | 查询当前注册运营商 |
| `requestNetworkRegistrationInfo(DOMAIN_PS)` | WWAN | PS | 蜂窝数据注册状态 |
| `requestNetworkRegistrationInfo(DOMAIN_CS)` | WWAN | CS | 语音注册状态 |
| `requestNetworkRegistrationInfo(DOMAIN_PS)` | WLAN | PS | IWLAN 注册状态 |
| `getNetworkSelectionMode` | - | - | 网络选择模式 |

```java
private void pollStateInternal(boolean modemTriggered) {
    mPollingContext = new int[1];

    log("pollState: modemTriggered=" + modemTriggered
        + ", radioState=" + mCi.getRadioState());

    switch (mCi.getRadioState()) {
        case TelephonyManager.RADIO_POWER_UNAVAILABLE:
            handlePollStateInternalForRadioOffOrUnavailable(false);
            pollStateDone();
            break;

        case TelephonyManager.RADIO_POWER_OFF:
            handlePollStateInternalForRadioOffOrUnavailable(true);
            if (mDeviceShuttingDown ||
                (!modemTriggered && ServiceState.RIL_RADIO_TECHNOLOGY_IWLAN
                    != mSS.getRilDataRadioTechnology())) {
                pollStateDone();
                break;
            }

        default:
            // 并行发起所有查询请求，通过 mPollingContext 计数等待全部返回
            mPollingContext[0]++;
            mCi.getOperator(obtainMessage(
                EVENT_POLL_STATE_OPERATOR, mPollingContext));

            mPollingContext[0]++;
            mRegStateManagers.get(AccessNetworkConstants.TRANSPORT_TYPE_WWAN)
                .requestNetworkRegistrationInfo(
                    NetworkRegistrationInfo.DOMAIN_PS,
                    obtainMessage(EVENT_POLL_STATE_PS_CELLULAR_REGISTRATION,
                        mPollingContext));

            mPollingContext[0]++;
            mRegStateManagers.get(AccessNetworkConstants.TRANSPORT_TYPE_WWAN)
                .requestNetworkRegistrationInfo(
                    NetworkRegistrationInfo.DOMAIN_CS,
                    obtainMessage(EVENT_POLL_STATE_CS_CELLULAR_REGISTRATION,
                        mPollingContext));

            if (mRegStateManagers.get(
                    AccessNetworkConstants.TRANSPORT_TYPE_WLAN) != null) {
                mPollingContext[0]++;
                mRegStateManagers.get(
                        AccessNetworkConstants.TRANSPORT_TYPE_WLAN)
                    .requestNetworkRegistrationInfo(
                        NetworkRegistrationInfo.DOMAIN_PS,
                        obtainMessage(EVENT_POLL_STATE_PS_IWLAN_REGISTRATION,
                            mPollingContext));
            }

            if (mPhone.isPhoneTypeGsm()) {
                mPollingContext[0]++;
                mCi.getNetworkSelectionMode(obtainMessage(
                    EVENT_POLL_STATE_NETWORK_SELECTION_MODE, mPollingContext));
            }
            break;
    }
}
```

## 八、驻网状态更新（pollStateDone）

当所有 5 个请求都返回后，消息处理完毕，执行 `pollStateDone()` 方法更新驻网信息。

### 关键变量：mPollingContext

`mPollingContext` 是一个全局计数器，控制是否所有轮询请求都已完成。每个请求发起前 `mPollingContext[0]++`，每个请求返回后 `mPollingContext[0]--`，当计数归零时才执行 `pollStateDone()` 更新当前服务状态。

> **[流程图]** pollStateDone() 方法中 mPollingContext 计数归零判断逻辑

### 状态变化检测与通知

只有当驻网相关信息发生变化时，才会触发服务状态通知：

```java
log("Broadcasting ServiceState : " + mSS);
// 仅在合并服务状态发生变化时通知
if (!oldMergedSS.equals(mPhone.getServiceState())) {
    mPhone.notifyServiceStateChanged(mPhone.getServiceState());
}
```

更新流程：
1. 将 `mNewSS` 的值赋给 `mSS`
2. 将 `mNewSS` 重置为无服务状态
3. 调用 `Phone.notifyServiceStateChanged()`
4. 最终调用到 `TelephonyRegistry.notifyServiceStateForPhoneId()`
5. 遍历所有注册了 `TelephonyCallback.EVENT_SERVICE_STATE_CHANGED` 的监听者，逐一回调

> **[流程图]** ServiceState 更新与广播通知链路

### TelephonyRegistry 通知分发

```java
public void notifyServiceStateForPhoneId(int phoneId, int subId,
        ServiceState state) {
    if (!checkNotifyPermission("notifyServiceState()")) {
        return;
    }

    final long callingIdentity = Binder.clearCallingIdentity();
    try {
        synchronized (mRecords) {
            if (validatePhoneId(phoneId)) {
                mServiceState[phoneId] = state;

                if (SubscriptionManager.isValidSubscriptionId(subId)) {
                    for (Record r : mRecords) {
                        if (r.matchTelephonyCallbackEvent(
                                TelephonyCallback.EVENT_SERVICE_STATE_CHANGED)
                                && idMatch(r, subId, phoneId)) {
                            try {
                                ServiceState stateToSend;
                                if (checkFineLocationAccess(r,
                                        Build.VERSION_CODES.Q)) {
                                    stateToSend = new ServiceState(state);
                                } else if (checkCoarseLocationAccess(
                                        r, Build.VERSION_CODES.Q)) {
                                    stateToSend = state
                                        .createLocationInfoSanitizedCopy(false);
                                } else {
                                    stateToSend = state
                                        .createLocationInfoSanitizedCopy(true);
                                }
                                r.callback.onServiceStateChanged(stateToSend);
                            } catch (RemoteException ex) {
                                mRemoveList.add(r.binder);
                            }
                        }
                    }
                }
                handleRemoveListLocked();
            }
            broadcastServiceStateChanged(state, phoneId, subId);
        }
    } finally {
        Binder.restoreCallingIdentity(callingIdentity);
    }
}
```

## 九、总结

开机驻网完整链路可以概括为以下 6 个阶段：

```
AMS 拉起 Phone 进程
  → ServiceStateTracker 初始化
    → NetworkRegistrationManager 初始化（按 Transport 分离）
      → 绑定 CellularNetworkService（bindService + onServiceConnected）
        → 注册监听底层服务状态变化
          → Modem 上报 UNSOL → pollStateInternal（5 路并行查询）
            → pollStateDone → 更新 ServiceState → TelephonyRegistry 广播通知
```

**排障要点**：
- 开机驻网慢：重点排查 `onServiceConnected` 回调时机、`pollStateInternal` 中 Radio 状态、`mPollingContext` 计数是否正常归零
- 驻网状态不更新：检查 `oldMergedSS.equals(mPhone.getServiceState())` 比较逻辑，确认 `mNewSS` 到 `mSS` 的赋值是否执行
- 监听收不到通知：确认 `SubscriptionManager.isValidSubscriptionId(subId)` 和 `validatePhoneId(phoneId)` 是否通过
