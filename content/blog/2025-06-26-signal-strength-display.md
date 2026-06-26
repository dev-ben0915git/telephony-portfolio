---
title: "Android Telephony 信号显示全流程分析"
date: "2025-06-26"
summary: "从 Modem 射频测量到 SystemUI 状态栏渲染的完整链路，涵盖 HAL 信号转换（含信号取反处理）、RILUtils 数据转换、SignalStrength 格数计算、Registrant 通知机制到 TelephonyRegistry 广播分发。"
category: "network-search"
tags: ["SignalStrengthController", "SignalStrength", "CellSignalStrengthLte", "CellSignalStrengthNr", "NetworkIndication", "RILUtils", "TelephonyRegistry", "SystemUI", "RSRP", "updateLevel"]
featured: true
---

## 第 1 章：概述

### 1.1 信号显示是什么

Telephony 信号显示是指 Android 设备状态栏中蜂窝网络信号强度图标的展示过程。从 Modem 测量到射频信号参数，到 Framework 层将原始数值转换为 0-4 格的信号图标，再到 SystemUI 渲染到状态栏，涉及 HAL、RIL、Telephony Framework、System Service 和应用层的多层协作。

### 1.2 整体流程总览

```
Modem 测量射频信号 → 主动上报 currentSignalStrength
  ↓
NetworkIndication (AIDL HAL) 接收并转换
  ↓
RILUtils.convertHalSignalStrength() —— HAL → Framework 数据转换（含信号取反）
  ↓
Registrant 通知机制 → SignalStrengthController
  ↓
onSignalStrengthResult() → updateSignalStrength()
  ↓
SignalStrength.updateLevel() —— 各网络类型计算信号格数
  ↓
notifySignalStrength() → Phone → DefaultPhoneNotifier
  ↓
TelephonyRegistryManager → TelephonyRegistry
  ↓
遍历监听器回调 onSignalStrengthsChanged()
  ↓
SystemUI 更新状态栏信号图标
```

### 1.3 为什么需要信号取反处理

HAL 层（Modem 侧）与 Framework 层对信号数值的表示约定不同：

- **HAL 侧**：某些信号值使用正数 ASU（Arbitrary Strength Unit）或绝对值表示，如 GSM RSSI 用 0-31 的 ASU 值，NR SS-RSRP 用正数表示
- **Framework 侧**：使用负数 dBm 表示信号功率（如 -80 dBm），数值越小信号越弱

因此，在 `RILUtils` 转换时需要对信号值进行取反或单位转换：
- `getRssiDbmFromAsu()`：将 GSM ASU 转换为 dBm（负数）
- `flip()`：将 NR 等 HAL 正数信号值取反为负数 dBm

---

## 第 2 章：关键类与数据结构

### 2.1 SignalStrengthController：信号强度核心控制器

**文件**：SignalStrengthController.java

`SignalStrengthController` 是信号强度管理的核心类，主要职责：

- **监听 Modem 信号变化**：通过 `mCi.setOnSignalStrengthUpdate()` 注册信号强度更新监听
- **处理信号上报**：接收 `EVENT_SIGNAL_STRENGTH_UPDATE` 消息，调用 `onSignalStrengthResult()`
- **更新信号强度**：`updateSignalStrength()` 更新内部 `mSignalStrength`，并调用 `updateLevel()` 计算格数
- **通知外部变化**：`notifySignalStrength()` 通知 Phone 和内部注册者
- **主动查询**：支持 `getSignalStrength()` 主动查询和轮询机制

### 2.2 SignalStrength：信号强度聚合数据类

**文件**：SignalStrength.java

`SignalStrength` 是一个聚合类，包含所有网络类型的信号强度子对象：

```java
public class SignalStrength implements Parcelable {
    private CellSignalStrengthCdma mCdma;
    private CellSignalStrengthGsm mGsm;
    private CellSignalStrengthWcdma mWcdma;
    private CellSignalStrengthTdscdma mTdscdma;
    private CellSignalStrengthLte mLte;
    private CellSignalStrengthNr mNr;
}
```

核心方法：
- `updateLevel(PersistableBundle cc, ServiceState ss)`：遍历所有子对象调用 `updateLevel()`
- `getLevel()`：获取当前信号格数（0-4）
- `getGsmSignalStrength()` / `getLteRsrp()` / `getNrSsRsrp()`：获取各网络类型的具体信号值

### 2.3 CellSignalStrength 系列：各网络类型信号强度

| 类 | 文件 | 关键指标 | 说明 |
|----|------|---------|------|
| `CellSignalStrengthCdma` | CellSignalStrengthCdma.java | cdmaDbm、evdoDbm | CDMA 网络 |
| `CellSignalStrengthGsm` | CellSignalStrengthGsm.java | rssi、ber、timingAdvance | GSM 网络 |
| `CellSignalStrengthWcdma` | CellSignalStrengthWcdma.java | rssi、rscp、ecNo | WCDMA 网络 |
| `CellSignalStrengthTdscdma` | CellSignalStrengthTdscdma.java | rssi、rscp | TD-SCDMA 网络 |
| `CellSignalStrengthLte` | CellSignalStrengthLte.java | rsrp、rsrq、rssnr、cqi | LTE 网络 |
| `CellSignalStrengthNr` | CellSignalStrengthNr.java | ssRsrp、ssRsrq、ssSinr | 5G NR 网络 |

每个子类都实现了 `updateLevel(PersistableBundle cc, ServiceState ss)` 方法，根据运营商配置阈值将信号值映射为 0-4 的格数。

### 2.4 NtnSignalStrength：非地面网络信号强度

**文件**：NtnSignalStrength.java

`NtnSignalStrength`（Non-Terrestrial Network）用于卫星网络信号强度表示。当设备连接到卫星网络时，使用独立的信号强度等级（0-4）。

### 2.5 NetworkIndication / RILUtils：HAL 信号转换层

**文件**：
- NetworkIndication.java
- RILUtils.java

`NetworkIndication` 是 AIDL HAL 接口 `IRadioNetworkIndication` 的实现，负责接收 Modem 上报的网络相关指示，包括 `currentSignalStrength`。

`RILUtils` 提供 HAL 数据结构与 Framework 数据结构之间的转换方法，特别是 `convertHalSignalStrength()` 将 HAL 的 `SignalStrength` 转换为 Framework 的 `SignalStrength`。

### 2.6 TelephonyRegistry / TelephonyCallback：系统通知层

**文件**：
- TelephonyRegistry.java
- TelephonyCallback.java

`TelephonyRegistry` 是系统服务，管理所有对信号强度变化的监听器。应用通过 `TelephonyManager.listen()` 或 `registerTelephonyCallback()` 注册监听，`TelephonyRegistry` 在信号变化时回调注册的监听器。

`TelephonyCallback.SignalStrengthsListener` 是现代推荐的信号强度监听接口，替代已废弃的 `PhoneStateListener`。

---

## 第 3 章：RIL 消息交互

### 3.1 RIL_UNSOL_SIGNAL_STRENGTH：Modem 主动上报

**方向**：Modem → Framework

Modem 会周期性地或在信号发生显著变化时，主动上报当前信号强度。在 AIDL HAL 接口中，这通过 `IRadioNetworkIndication.currentSignalStrength()` 方法实现。

**Framework 接收端**：NetworkIndication.currentSignalStrength()

```java
public void currentSignalStrength(int indicationType,
        android.hardware.radio.network.SignalStrength signalStrength) {
    mRil.processIndication(HAL_SERVICE_NETWORK, indicationType);
    SignalStrength ss = RILUtils.convertHalSignalStrength(signalStrength);
    if (mRil.isLogvOrTrace()) mRil.unsljLogvRet(RIL_UNSOL_SIGNAL_STRENGTH, ss);
    if (mRil.mSignalStrengthRegistrant != null) {
        mRil.mSignalStrengthRegistrant.notifyRegistrant(new AsyncResult(null, ss, null));
    }
}
```

### 3.2 RIL_REQUEST_SIGNAL_STRENGTH：Framework 主动查询

**方向**：Framework → Modem

当应用调用 `TelephonyManager.getSignalStrength()` 且本地缓存的信号强度已过期时，`SignalStrengthController` 会主动向 Modem 查询当前信号强度。

**触发位置**：SignalStrengthController.getSignalStrength()

```java
public SignalStrength getSignalStrength() {
    if (shouldRefreshSignalStrength()) {
        obtainMessage(EVENT_POLL_SIGNAL_STRENGTH).sendToTarget();
    }
    return mSignalStrength;
}
```

### 3.3 HAL 接口演进（HIDL 1.4/1.6 → AIDL NetworkIndication）

Android 信号强度 HAL 接口经历了多次演进：

| HAL 版本 | 接口位置 | 说明 |
|---------|---------|------|
| HIDL 1.4 | `android.hardware.radio@1.4::IRadioIndication` | `currentSignalStrength_1_4()` |
| HIDL 1.6 | `android.hardware.radio@1.6::IRadioIndication` | `currentSignalStrength_1_6()`，支持更多 NR 参数 |
| AIDL | `android.hardware.radio.network::IRadioNetworkIndication` | `currentSignalStrength()`，当前主流接口 |

在较新的 Android 版本中，网络相关的指示已从 `RadioIndication` 分离到 `NetworkIndication`（AIDL 接口），信号强度上报通过 `NetworkIndication.currentSignalStrength()` 接收。

---

## 第 4 章：Modem 信号上报与 Framework 转换

### 4.1 Modem 主动上报 currentSignalStrength

Modem 根据内部策略周期性或在信号显著变化时，通过 HAL 接口上报 `currentSignalStrength`。上报的数据结构包含各网络类型的信号参数：

```
android.hardware.radio.network.SignalStrength
  ├── gsm: GsmSignalStrength (signalStrength, bitErrorRate, timingAdvance)
  ├── cdma: CdmaSignalStrength (dbm, ecio)
  ├── evdo: EvdoSignalStrength (dbm, ecio, signalNoiseRatio)
  ├── lte: LteSignalStrength (signalStrength, rsrp, rsrq, rssnr, cqi, timingAdvance)
  ├── tdscdma: TdscdmaSignalStrength (signalStrength, rscp)
  ├── wcdma: WcdmaSignalStrength (signalStrength, rscp, ecno)
  └── nr: NrSignalStrength (ssRsrp, ssRsrq, ssSinr, csiRsrp, csiRsrq, csiSinr)
```

### 4.2 NetworkIndication 接收（AIDL HAL 接口）

**位置**：NetworkIndication.currentSignalStrength()

`NetworkIndication` 接收到 Modem 上报后，执行以下步骤：

1. **处理指示类型**：`mRil.processIndication(HAL_SERVICE_NETWORK, indicationType)`
2. **数据转换**：调用 `RILUtils.convertHalSignalStrength(signalStrength)` 将 HAL 数据结构转换为 Framework `SignalStrength`
3. **日志记录**：记录信号强度值（verbose 级别，避免频繁日志）
4. **通知注册者**：通过 `mSignalStrengthRegistrant.notifyRegistrant()` 通知已注册的监听者

### 4.3 RILUtils.convertHalSignalStrength() 转换详解

**位置**：RILUtils.convertHalSignalStrength()

```java
public static SignalStrength convertHalSignalStrength(
        android.hardware.radio.network.SignalStrength signalStrength) {
    return new SignalStrength(
            convertHalCdmaSignalStrength(signalStrength.cdma, signalStrength.evdo),
            convertHalGsmSignalStrength(signalStrength.gsm),
            convertHalWcdmaSignalStrength(signalStrength.wcdma),
            convertHalTdscdmaSignalStrength(signalStrength.tdscdma),
            convertHalLteSignalStrength(signalStrength.lte),
            convertHalNrSignalStrength(signalStrength.nr));
}
```

#### 4.3.1 信号取反处理原理

**GSM 转换**：RILUtils.convertHalGsmSignalStrength()

```java
public static CellSignalStrengthGsm convertHalGsmSignalStrength(
        android.hardware.radio.V1_0.GsmSignalStrength ss) {
    if (ss == null) return new CellSignalStrengthGsm();
    CellSignalStrengthGsm ret = new CellSignalStrengthGsm(
            CellSignalStrength.getRssiDbmFromAsu(ss.signalStrength), ss.bitErrorRate,
            ss.timingAdvance);
    if (ret.getRssi() == CellInfo.UNAVAILABLE) {
        ret.setDefaultValues();
        ret.updateLevel(null, null);
    }
    return ret;
}
```

**`getRssiDbmFromAsu()` 原理**：

```java
public static int getRssiDbmFromAsu(int asu) {
    // ASU 范围 0-31（99 表示未知）
    // dBm = ASU * 2 - 113（GSM 公式）
    if (asu == 99 || asu == CellInfo.UNAVAILABLE) return CellInfo.UNAVAILABLE;
    return asu * 2 - 113;  // 结果范围：-113 ~ -51 dBm
}
```

**NR 转换中的 `flip()`**：CellSignalStrengthNr.flip()

```java
public static int flip(int val) {
    return val != CellInfo.UNAVAILABLE ? -val : val;
}
```

HAL 侧 NR 的 SS-RSRP 等参数使用正数表示（如 80 代表 -80 dBm），Framework 侧使用负数 dBm，因此需要 `flip()` 取反。

#### 4.3.2 各网络类型转换差异

| 网络类型 | HAL 表示 | Framework 表示 | 转换方法 |
|---------|---------|---------------|---------|
| GSM | ASU (0-31) | dBm (负数) | `getRssiDbmFromAsu()` |
| WCDMA | ASU + RSCP | dBm + RSCP dBm | `getRssiDbmFromAsu()` + `getRscpDbmFromAsu()` |
| LTE | RSRP 正数 | RSRP 负数 dBm | 直接取负（部分版本） |
| NR | SS-RSRP 正数 | SS-RSRP 负数 dBm | `flip()` |
| CDMA | dBm 负数 | dBm 负数 | 直接透传 |

### 4.4 Registrant 通知机制

`RIL` 中维护了一个 `mSignalStrengthRegistrant` 注册者：

```java
// RIL.java
public Registrant mSignalStrengthRegistrant;
```

`SignalStrengthController` 在初始化时通过 `setOnSignalStrengthUpdate()` 注册自己为信号强度变化的监听者：

```java
mCi.setOnSignalStrengthUpdate(this, EVENT_SIGNAL_STRENGTH_UPDATE, null);
```

当 Modem 上报信号强度时，`RIL` 通过 `mSignalStrengthRegistrant.notifyRegistrant()` 发送 `AsyncResult`，`SignalStrengthController` 的 Handler 收到 `EVENT_SIGNAL_STRENGTH_UPDATE` 消息。

### 4.5 SignalStrengthController 初始化监听

**位置**：SignalStrengthController 构造函数

```java
public SignalStrengthController(@NonNull Phone phone, @NonNull CommandsInterface ci,
        @NonNull FeatureFlags featureFlags) {
    super(phone, ci, featureFlags);
    // 注册信号强度更新监听
    mCi.setOnSignalStrengthUpdate(this, EVENT_SIGNAL_STRENGTH_UPDATE, null);
    setSignalStrengthDefaultValues();
    // 注册运营商配置变化监听
    CarrierConfigManager ccm = mPhone.getContext().getSystemService(CarrierConfigManager.class);
    if (ccm != null) {
        ccm.registerCarrierConfigChangeListener(this::post,
                (slotIndex, subId, carrierId, specificCarrierId) ->
                        onCarrierConfigurationChanged(slotIndex));
    }
}
```

初始化时还会设置默认信号强度值（所有参数为 `UNAVAILABLE`，level 为 0）。

### 4.6 EVENT_SIGNAL_STRENGTH_UPDATE 消息处理

**位置**：SignalStrengthController.handleMessage()

```java
case EVENT_SIGNAL_STRENGTH_UPDATE: {
    // This is a notification from CommandsInterface.setOnSignalStrengthUpdate
    ar = (AsyncResult) msg.obj;
    onSignalStrengthResult(ar);
    break;
}
```

### 4.7 onSignalStrengthResult() 异常处理

**位置**：SignalStrengthController.onSignalStrengthResult()

```java
private void onSignalStrengthResult(@NonNull AsyncResult ar) {
    SignalStrength signalStrength;
    if ((ar.exception == null) && (ar.result != null)) {
        signalStrength = (SignalStrength) ar.result;
    } else {
        loge("onSignalStrengthResult() Exception from RIL : " + ar.exception);
        signalStrength = new SignalStrength();  // 创建默认值
    }
    updateSignalStrength(signalStrength);
}
```

异常处理：
- **正常情况**：从 `ar.result` 取出 `SignalStrength` 对象
- **异常情况**（RIL 异常或 result 为空）：创建一个新的默认 `SignalStrength`（所有值为 `UNAVAILABLE`）

---

## 第 5 章：信号格数计算（updateLevel）

### 5.1 SignalStrength.updateLevel() 总体流程

**位置**：SignalStrength.updateLevel()

```java
public void updateLevel(PersistableBundle cc, ServiceState ss) {
    if (cc != null) {
        mLteAsPrimaryInNrNsa = cc.getBoolean(
                CarrierConfigManager.KEY_SIGNAL_STRENGTH_NR_NSA_USE_LTE_AS_PRIMARY_BOOL, true);
    }
    mCdma.updateLevel(cc, ss);
    mGsm.updateLevel(cc, ss);
    mWcdma.updateLevel(cc, ss);
    mTdscdma.updateLevel(cc, ss);
    mLte.updateLevel(cc, ss);
    mNr.updateLevel(cc, ss);
}
```

`SignalStrength.updateLevel()` 遍历所有网络类型的子对象，逐个调用其 `updateLevel()` 方法。每个子对象根据运营商配置（`PersistableBundle`）和服务状态（`ServiceState`）独立计算自己的信号格数。

### 5.2 CellSignalStrengthLte.updateLevel() 详解

**位置**：CellSignalStrengthLte.updateLevel()

#### 5.2.1 RSRP/RSRQ/RSSNR 阈值配置

LTE 信号格数计算基于三个参数，优先级从高到低：

| 参数 | 说明 | 默认阈值（dB/dBm） |
|------|------|------------------|
| RSRP | 参考信号接收功率 | [-118, -115, -112, -109, -106] |
| RSRQ | 参考信号接收质量 | [-30, -17, -14, -11, -8] |
| RSSNR | 参考信号信噪比 | [-3, 1, 5, 9, 13] |

运营商可以通过 CarrierConfig 自定义这些阈值。

#### 5.2.2 参数优先级选择

```java
// 从 CarrierConfig 读取使用哪些参数计算格数
mParametersUseForLevel = cc.getInt(
        CarrierConfigManager.KEY_PARAMETERS_USED_FOR_LTE_SIGNAL_BAR_INT);
```

可选参数组合：
- `USE_RSRP`：仅使用 RSRP
- `USE_RSRQ`：仅使用 RSRQ
- `USE_RSSNR`：仅使用 RSSNR
- 组合使用：按优先级依次计算，取最小值

#### 5.2.3 卫星网络（NTN）特殊阈值

当连接到非地面网络（卫星）时，使用独立的 NTN 阈值：

```java
if (ss != null && ss.isUsingNonTerrestrialNetwork()) {
    mParametersUseForLevel = cc.getInt(
            CarrierConfigManager.KEY_PARAMETERS_USED_FOR_NTN_LTE_SIGNAL_BAR_INT);
    rsrpThresholds = cc.getIntArray(
            CarrierConfigManager.KEY_NTN_LTE_RSRP_THRESHOLDS_INT_ARRAY);
    // ... NTN 专用阈值
}
```

#### 5.2.4 格数计算方法

```java
private int updateLevelWithMeasure(int measure, int[] thresholds) {
    if (measure == CellInfo.UNAVAILABLE) {
        return SignalStrength.INVALID;  // 信号不可用
    }
    // 从 thresholds[0] 开始比较，找到 measure 所在的区间
    for (int i = 0; i < thresholds.length; i++) {
        if (measure < thresholds[i]) {
            return i;  // 0-4 格
        }
    }
    return thresholds.length;  // 最高格数
}
```

**计算逻辑**：阈值数组通常是 4 个元素（5 个区间），表示从弱到强的分界点。信号值与阈值比较，落在哪个区间就对应哪个格数（0-4）。

### 5.3 CellSignalStrengthNr.updateLevel() 详解

**位置**：CellSignalStrengthNr.updateLevel()

#### 5.3.1 SS-RSRP/SS-RSRQ/SS-SINR 阈值

5G NR 信号格数计算基于三个同步信号参数：

| 参数 | 说明 | 默认阈值 |
|------|------|---------|
| SS-RSRP | 同步信号参考信号接收功率 | [-110, -100, -90, -80] |
| SS-RSRQ | 同步信号参考信号接收质量 | [-31, -19, -13, -8] |
| SS-SINR | 同步信号信噪比 | [-5, 5, 15, 25] |

#### 5.3.2 RSRP Boost 处理

某些场景下会对 RSRP 进行 Boost（增益）处理：

```java
ssRsrpLevel = updateLevelWithMeasure(mSsRsrp + rsrpBoost, mSsRsrpThresholds);
```

`rsrpBoost` 的值来自运营商配置，用于调整信号格数的敏感度。

#### 5.3.3 最终格数确定

NR 的最终格数取三个参数计算结果的最小值：

```java
mLevel = Math.min(Math.min(ssRsrpLevel, ssRsrqLevel), ssSinrLevel);
```

这意味着只要有一个参数较差，整体格数就会降低，确保用户体验的一致性。

### 5.4 其他网络类型（GSM/WCDMA/CDMA/TD-SCDMA）

其他网络类型的 `updateLevel()` 逻辑类似，但使用的参数和阈值不同：

| 网络类型 | 主要参数 | 说明 |
|---------|---------|------|
| GSM | RSSI (dBm) | 信号强度指示 |
| WCDMA | RSCP (dBm) | 接收信号码功率 |
| CDMA | cdmaDbm / evdoDbm | CDMA / EVDO 信号强度 |
| TD-SCDMA | RSCP (dBm) | 接收信号码功率 |

### 5.5 updateLevelWithMeasure() 通用计算方法

**通用算法**：

```java
private int updateLevelWithMeasure(int measure, int[] thresholds) {
    if (measure == CellInfo.UNAVAILABLE) {
        return SignalStrength.INVALID;
    }
    int level = thresholds.length;  // 默认最高格
    for (int i = 0; i < thresholds.length; i++) {
        if (measure < thresholds[i]) {
            level = i;
            break;
        }
    }
    return level;
}
```

**示例**：RSRP 阈值 = [-118, -115, -112, -109]

| RSRP 值 | 计算过程 | 格数 |
|---------|---------|------|
| -120 dBm | -120 < -118 | 0 |
| -116 dBm | -118 <= -116 < -115 | 1 |
| -113 dBm | -115 <= -113 < -112 | 2 |
| -110 dBm | -112 <= -110 < -109 | 3 |
| -100 dBm | -100 >= -109 | 4 |

---

## 第 6 章：信号强度通知到 SystemUI

### 6.1 SignalStrengthController.notifySignalStrength()

**位置**：SignalStrengthController.notifySignalStrength()

```java
void notifySignalStrength() {
    int subId = mPhone.getSubId();
    if (!mSignalStrength.equals(mLastSignalStrength) || subId != mLastSubId) {
        try {
            mSignalStrengthChangedRegistrants.notifyRegistrants();
            mPhone.notifySignalStrength();
            mLastSignalStrength = mSignalStrength;
            mLastSubId = subId;
        } catch (NullPointerException ex) {
            loge("updateSignalStrength() Phone already destroyed: " + ex
                    + "SignalStrength not notified");
        }
    }
}
```

**去重逻辑**：只有当信号强度发生变化或 subId 变化时，才发送通知。避免不必要的系统资源消耗。

**通知对象**：
1. `mSignalStrengthChangedRegistrants`：内部注册者（如 `ServiceStateTracker`）
2. `mPhone.notifySignalStrength()`：通过 PhoneNotifier 通知外部系统服务

### 6.2 Phone.notifySignalStrength() → DefaultPhoneNotifier

**位置**：Phone.notifySignalStrength()

```java
public void notifySignalStrength() {
    mNotifier.notifySignalStrength(this);
}
```

**位置**：DefaultPhoneNotifier.notifySignalStrength()

```java
public void notifySignalStrength(Phone sender) {
    int phoneId = sender.getPhoneId();
    int subId = sender.getSubId();
    mTelephonyRegistryMgr.notifySignalStrengthChanged(phoneId, subId,
            sender.getSignalStrength());
}
```

`DefaultPhoneNotifier` 是 `PhoneNotifier` 的默认实现，负责将 Phone 内部的状态变化通知到系统服务 `TelephonyRegistry`。

### 6.3 TelephonyRegistryManager.notifySignalStrengthChanged()

**位置**：TelephonyRegistryManager.notifySignalStrengthChanged()

```java
public void notifySignalStrengthChanged(int slotIndex, int subId,
        @NonNull SignalStrength signalStrength) {
    try {
        sRegistry.notifySignalStrengthForPhoneId(slotIndex, subId, signalStrength);
    } catch (RemoteException ex) {
        throw ex.rethrowFromSystemServer();
    }
}
```

`TelephonyRegistryManager` 是 `TelephonyRegistry` 的客户端代理，通过 Binder IPC 调用系统服务端的 `notifySignalStrengthForPhoneId()`。

### 6.4 TelephonyRegistry.notifySignalStrengthForPhoneId()

**位置**：TelephonyRegistry.notifySignalStrengthForPhoneId()

```java
public void notifySignalStrengthForPhoneId(int phoneId, int subId,
            SignalStrength signalStrength) {
    if (!checkNotifyPermission("notifySignalStrength()")) {
        return;
    }
    synchronized (mRecords) {
        if (validatePhoneId(phoneId)) {
            mSignalStrength[phoneId] = signalStrength;
            for (Record r : mRecords) {
                // 通知 EVENT_SIGNAL_STRENGTHS_CHANGED 监听器
                if (r.matchTelephonyCallbackEvent(
                        TelephonyCallback.EVENT_SIGNAL_STRENGTHS_CHANGED)
                        && idMatch(r, subId, phoneId)) {
                    try {
                        r.callback.onSignalStrengthsChanged(new SignalStrength(signalStrength));
                    } catch (RemoteException ex) {
                        mRemoveList.add(r.binder);
                    }
                }
                // 通知 EVENT_SIGNAL_STRENGTH_CHANGED 监听器（旧接口）
                if (r.matchTelephonyCallbackEvent(
                        TelephonyCallback.EVENT_SIGNAL_STRENGTH_CHANGED)
                        && idMatch(r, subId, phoneId)) {
                    try {
                        int gsmSignalStrength = signalStrength.getGsmSignalStrength();
                        int ss = (gsmSignalStrength == 99 ? -1 : gsmSignalStrength);
                        r.callback.onSignalStrengthChanged(ss);
                    } catch (RemoteException ex) {
                        mRemoveList.add(r.binder);
                    }
                }
            }
        }
        handleRemoveListLocked();
    }
    broadcastSignalStrengthChanged(signalStrength, phoneId, subId);
}
```

**关键逻辑**：
- **权限检查**：只有具有通知权限的调用者才能触发信号强度广播
- **存储更新**：将新信号强度存入 `mSignalStrength[phoneId]`
- **遍历监听器**：遍历所有注册的记录（`mRecords`）
  - 匹配 `EVENT_SIGNAL_STRENGTHS_CHANGED` → 回调 `onSignalStrengthsChanged(SignalStrength)`
  - 匹配 `EVENT_SIGNAL_STRENGTH_CHANGED` → 回调 `onSignalStrengthChanged(int asu)`（旧接口，已废弃）
- **异常处理**：如果回调时抛出 `RemoteException`（应用已退出），将其加入移除列表
- **Sticky Broadcast**：发送 `ACTION_SIGNAL_STRENGTH_CHANGED` 广播

### 6.5 broadcastSignalStrengthChanged() Sticky Broadcast

**位置**：TelephonyRegistry.broadcastSignalStrengthChanged()

```java
private void broadcastSignalStrengthChanged(SignalStrength signalStrength, int phoneId,
        int subId) {
    final long ident = Binder.clearCallingIdentity();
    try {
        mBatteryStats.notePhoneSignalStrength(signalStrength);
    } catch (RemoteException e) {
        /* The remote entity disappeared, we can safely ignore the exception. */
    } finally {
        Binder.restoreCallingIdentity(ident);
    }

    Intent intent = new Intent(ACTION_SIGNAL_STRENGTH_CHANGED);
    Bundle data = new Bundle();
    fillInSignalStrengthNotifierBundle(signalStrength, data);
    intent.putExtras(data);
    intent.putExtra(PHONE_CONSTANTS_SUBSCRIPTION_KEY, subId);
    intent.putExtra(PHONE_CONSTANTS_SLOT_KEY, phoneId);
    mContext.sendStickyBroadcastAsUser(intent, UserHandle.ALL);
}
```

除了回调已注册的监听器外，`TelephonyRegistry` 还会发送一个 Sticky Broadcast：
- **电量统计**：通知 `BatteryStats` 记录信号强度变化（用于电量消耗估算）
- **Sticky Broadcast**：发送 `ACTION_SIGNAL_STRENGTH_CHANGED`，携带完整的 `SignalStrength` 数据

### 6.6 SystemUI 接收端

SystemUI 通过 `TelephonyCallback.SignalStrengthsListener` 接收信号强度变化：

```java
// SystemUI 中的 MobileStatusTracker 或 StatusBarSignalPolicy
TelephonyManager.listen(mPhoneStateListener,
        PhoneStateListener.LISTEN_SIGNAL_STRENGTHS);

// 或使用新的 TelephonyCallback
TelephonyManager.registerTelephonyCallback(mExecutor, new TelephonyCallback.
        SignalStrengthsListener() {
    @Override
    public void onSignalStrengthsChanged(SignalStrength signalStrength) {
        // 更新信号图标
        updateSignalIcon(signalStrength);
    }
});
```

### 6.7 状态栏信号图标更新

SystemUI 收到 `onSignalStrengthsChanged()` 回调后：

1. **获取信号格数**：`signalStrength.getLevel()` 返回 0-4 的格数
2. **获取网络类型**：判断当前是 5G、LTE、3G 还是 2G
3. **选择图标资源**：根据格数和网络类型选择对应的信号图标
4. **渲染到状态栏**：更新状态栏右侧的信号图标显示

**完整通知链路时序图**：

```
SignalStrengthController.notifySignalStrength()
  ├── mSignalStrengthChangedRegistrants.notifyRegistrants()
  │   └── ServiceStateTracker 等内部模块
  └── mPhone.notifySignalStrength()
      ↓
  DefaultPhoneNotifier.notifySignalStrength(sender)
      ↓
  TelephonyRegistryManager.notifySignalStrengthChanged(slotIndex, subId, ss)
      ↓ (Binder IPC)
  TelephonyRegistry.notifySignalStrengthForPhoneId(phoneId, subId, ss)
      ├── 存储 mSignalStrength[phoneId]
      ├── 遍历 mRecords
      │   ├── r.callback.onSignalStrengthsChanged(new SignalStrength(ss))
      │   │   └── SystemUI.StatusBarSignalPolicy.onSignalStrengthsChanged()
      │   └── r.callback.onSignalStrengthChanged(asu)  // 旧接口
      └── broadcastSignalStrengthChanged()
          ├── mBatteryStats.notePhoneSignalStrength(ss)
          └── sendStickyBroadcast(ACTION_SIGNAL_STRENGTH_CHANGED)
```

---

## 第 7 章：主动查询机制

### 7.1 getSignalStrength() 触发条件

**位置**：SignalStrengthController.getSignalStrength()

```java
public SignalStrength getSignalStrength() {
    if (shouldRefreshSignalStrength()) {
        log("getSignalStrength() refreshing signal strength.");
        obtainMessage(EVENT_POLL_SIGNAL_STRENGTH).sendToTarget();
    }
    return mSignalStrength;
}
```

当应用调用 `TelephonyManager.getSignalStrength()` 时，会间接调用到这里。如果本地缓存的信号强度已过期，则触发主动查询。

### 7.2 EVENT_POLL_SIGNAL_STRENGTH 轮询机制

**位置**：SignalStrengthController.handleMessage()

```java
case EVENT_POLL_SIGNAL_STRENGTH: {
    mCi.getSignalStrength(obtainMessage(EVENT_POLL_SIGNAL_STRENGTH_DONE));
    break;
}
```

收到 `EVENT_POLL_SIGNAL_STRENGTH` 后，调用 `mCi.getSignalStrength()` 向 Modem 发送 `RIL_REQUEST_SIGNAL_STRENGTH` 请求。Modem 返回后，通过 `EVENT_POLL_SIGNAL_STRENGTH_DONE` 回调处理结果。

### 7.3 信号强度过期判断

**位置**：SignalStrengthController.shouldRefreshSignalStrength()

```java
private boolean shouldRefreshSignalStrength() {
    long curTime = System.currentTimeMillis();
    // 系统时间被回拨（mSignalStrengthUpdatedTime > curTime）也视为过期
    boolean isStale = (mSignalStrengthUpdatedTime > curTime)
            || (curTime - mSignalStrengthUpdatedTime > SIGNAL_STRENGTH_REFRESH_THRESHOLD_IN_MS);
    if (!isStale) return false;

    // 检查是否有活跃的订阅
    List<SubscriptionInfo> subInfoList = SubscriptionManagerService.getInstance()
            .getActiveSubscriptionInfoList(...);
    if (subInfoList == null || subInfoList.isEmpty()) {
        return false;  // 无活跃订阅，不刷新
    }
    return true;
}
```

**过期条件**（满足任一）：
- 距离上次更新时间超过 `SIGNAL_STRENGTH_REFRESH_THRESHOLD_IN_MS`（通常为 3000ms）
- 系统时间被回拨（`mSignalStrengthUpdatedTime > curTime`）

**不刷新条件**：
- 信号强度未过期
- 无活跃订阅

---

## 第 8 章：调试与日志

### 8.1 关键 Log TAG

| TAG | 类/模块 | 关注点 |
|-----|--------|--------|
| `SignalStrengthController` | SignalStrengthController | 信号更新、格数计算、通知 |
| `RILJ` | RIL | RIL 请求/响应、Modem 上报 |
| `NetworkIndication` | NetworkIndication | HAL 信号强度指示接收 |
| `TelephonyRegistry` | TelephonyRegistry | 监听器管理、回调通知 |
| `CellSignalStrengthLte` | CellSignalStrengthLte | LTE 格数计算、阈值应用 |
| `CellSignalStrengthNr` | CellSignalStrengthNr | NR 格数计算、阈值应用 |
| `SignalStrength` | SignalStrength | 聚合信号强度数据 |

### 8.2 常用过滤命令

```bash
adb logcat -b radio | grep -E "currentSignalStrength|EVENT_SIGNAL_STRENGTH_UPDATE|onSignalStrengthResult|updateSignalStrength|notifySignalStrength"

adb logcat -b radio | grep -E "updateLevel|RSRP Level|RSRQ Level|SSRSRP Level|signal strength level"

adb logcat -b all | grep -E "notifySignalStrengthForPhoneId|onSignalStrengthsChanged|broadcastSignalStrengthChanged"

adb logcat -b radio | grep -E "convertHalSignalStrength|getRssiDbmFromAsu|flip"

adb logcat -b all | grep -E "MobileStatusTracker|StatusBarSignalPolicy|signal.*icon"
```

### 8.3 dumpsys 调试

```bash
adb shell dumpsys telephony.registry | grep -A 20 "SignalStrength"

adb shell dumpsys phone | grep -A 30 "SignalStrengthController"

adb shell cmd phone info signal-strength
```

### 8.4 常见问题排查思路

**问题 1：信号图标不更新**
- 检查 `NetworkIndication.currentSignalStrength()` 是否收到 Modem 上报
- 查看 `onSignalStrengthResult()` 是否正常处理
- 检查 `updateSignalStrength()` 是否被调用
- 查看 `notifySignalStrength()` 是否发送通知（去重逻辑是否阻止了通知）

**问题 2：信号格数计算异常**
- 检查 `SignalStrength.updateLevel()` 是否被调用
- 查看 CarrierConfig 阈值配置是否正确
- 检查 `CellSignalStrengthLte/Nr.updateLevel()` 的计算结果
- 查看日志中 RSRP/SS-RSRP 原始值和计算出的 level

**问题 3：信号值与预期不符**
- 检查 HAL → Framework 转换是否正确（`flip()`、`getRssiDbmFromAsu()`）
- 对比 HAL 侧原始值和 Framework 侧转换后的值
- 检查是否有测试模式覆盖（`maybeOverrideSignalStrengthForTest()`）

**问题 4：SystemUI 收不到信号变化**
- 检查 `TelephonyRegistry.notifySignalStrengthForPhoneId()` 是否被调用
- 查看监听器是否正确注册（`EVENT_SIGNAL_STRENGTHS_CHANGED`）
- 检查 subId/phoneId 是否匹配
- 查看 `RemoteException` 是否导致监听器被移除