---
title: "Android 运营商名称显示机制详解"
date: "2025-06-24"
summary: "从 ServiceStateTracker.updateCarrierDisplayName() 入口，完整梳理 Legacy 机制下运营商名称显示的全流程：SPN/PLMN 来源优先级、SIM rule 显示规则、漫游/飞行模式/WFC/卫星等场景处理，以及 Intent 广播与上层消费。"
category: "data-service"
tags: ["ServiceStateTracker", "SPN", "PLMN", "SIM", "RIL", "Framework", "CarrierConfig", "WFC", "漫游"]
featured: true
---

> **文档定位**：面向 Android Framework 开发者的技术原理分析文档  
> **聚焦机制**：Legacy 机制（`getCarrierDisplayNameLegacy`）  
> **核心入口**：ServiceStateTracker.updateCarrierDisplayName()

---

## 第1章 概述

### 1.1 什么是运营商名称显示

在 Android Telephony 框架中，运营商名称显示是指手机状态栏、锁屏界面、设置页面等位置展示的当前网络运营商名称。这个看似简单的功能背后，涉及复杂的逻辑判断和多数据源优先级处理。

运营商名称有两个核心来源：

- **PLMN（Public Land Mobile Network）**：由网络侧通过 RIL（Radio Interface Layer）消息返回，代表当前注册的网络运营商名称
- **SPN（Service Provider Name）**：由 SIM 卡中的 EF_SPN 文件提供，代表 SIM 卡所属的服务提供商名称

### 1.2 为什么需要复杂的显示规则

运营商名称显示不是简单的二选一，而是需要考虑多种因素：

1. **漫游状态**：在漫游网络中，用户需要知道当前连接的是哪家运营商
2. **SIM 卡策略**：不同运营商对 SPN/PLMN 的显示有不同的策略要求
3. **特殊场景**：飞行模式、无服务、WiFi Calling、卫星通信等场景需要特殊处理
4. **运营商定制**：部分运营商要求覆盖默认显示逻辑

### 1.3 本文档范围

本文档聚焦 **Legacy 机制**（`getCarrierDisplayNameLegacy`），从 ServiceStateTracker.updateCarrierDisplayName() 入口开始，完整梳理运营商名称显示的整个流程。

> **注**：Android 后续引入了 CDNR（CarrierDisplayNameResolver）新机制，本文档不涉及其详细分析，仅在入口处做简要说明。

---

## 第2章 核心概念与术语

### 2.1 PLMN

**PLMN**（Public Land Mobile Network，公共陆地移动网络）在本文档语境下，指代**当前注册网络的运营商名称**。

- **来源**：Modem 通过 RIL 消息上报，存储在 ServiceState 的 `mOperatorAlphaLong` / `mOperatorAlphaShort` 字段
- **获取方式**：`mSS.getOperatorAlpha()` —— 优先返回长名，为空则返回短名
- **数字格式**：`mOperatorNumeric`（MCC+MNC，如 "46000"）

### 2.2 SPN

**SPN**（Service Provider Name，服务提供商名称）是 SIM 卡上存储的运营商名称。

- **来源**：SIM 卡 EF_SPN 文件（3GPP TS 31.102 section 4.2.12）
- **获取方式**：getServiceProviderName()
- **显示条件**：由 EF_SPN 第1字节的 Display Condition 决定

### 2.3 CarrierDisplayNameData

CarrierDisplayNameData 是承载最终显示结果的数据结构：

| 字段 | 类型 | 说明 |
|------|------|------|
| `mSpn` | String | 服务提供商名称 |
| `mDataSpn` | String | 数据服务提供商名称 |
| `mPlmn` | String | PLMN 网络名称 |
| `mShowSpn` | boolean | 是否显示 SPN |
| `mShowPlmn` | boolean | 是否显示 PLMN |

### 2.4 显示规则（rule / bitmask）

**显示规则**（`CARRIER_NAME_DISPLAY_BITMASK`）是 ServiceStateTracker 内部使用的 bitmask，决定 SPN 和 PLMN 的显示与否：

```java
// ServiceStateTracker.java
public static final int CARRIER_NAME_DISPLAY_BITMASK_SHOW_SPN = 1 << 0;  // 值为 1
public static final int CARRIER_NAME_DISPLAY_BITMASK_SHOW_PLMN = 1 << 1; // 值为 2
```

| rule 值 | 含义 |
|---------|------|
| 0 | 不显示 SPN，不显示 PLMN |
| 1 | 显示 SPN，不显示 PLMN |
| 2 | 不显示 SPN，显示 PLMN |
| 3 | 显示 SPN，显示 PLMN |

### 2.5 SIM 规则（sim rule / Display Condition）

**SIM 规则**来源于 SIM 卡 EF_SPN 文件的第1字节，通过 convertSpnDisplayConditionToBitmask() 转换为 `CARRIER_NAME_DISPLAY_CONDITION_BITMASK`：

```java
// IccRecords.java
public static final int CARRIER_NAME_DISPLAY_CONDITION_BITMASK_PLMN = 1; // bit0
public static final int CARRIER_NAME_DISPLAY_CONDITION_BITMASK_SPN = 2;  // bit1
```

**EF_SPN 第1字节的 bit 语义**（3GPP TS 31.102）：

| bit | 值 | 含义 |
|-----|-----|------|
| bit0 (b1) | 0 | 在 HPLMN 或 SPDI 列表中的 PLMN 注册时，**不显示** PLMN |
| bit0 (b1) | 1 | 在 HPLMN 或 SPDI 列表中的 PLMN 注册时，**显示** PLMN |
| bit1 (b2) | 0 | 在**非** HPLMN 且**非** SPDI 列表中的 PLMN 注册时，**显示** SPN |
| bit1 (b2) | 1 | 在**非** HPLMN 且**非** SPDI 列表中的 PLMN 注册时，**不显示** SPN |

> 注意：bit 的语义在转换时经过了取反处理。`convertSpnDisplayConditionToBitmask()` 将 bit0=1 转换为 `BITMASK_PLMN`，将 bit1=0 转换为 `BITMASK_SPN`。

---

## 第3章 代码入口与整体流程

### 3.1 核心入口：updateCarrierDisplayName()

ServiceStateTracker.updateCarrierDisplayName() 是运营商名称显示的核心入口方法：

```java
@VisibleForTesting
public void updateCarrierDisplayName() {
    final boolean useCdnr = mCarrierConfig.getBoolean(
            CarrierConfigManager.KEY_ENABLE_CARRIER_DISPLAY_NAME_RESOLVER_BOOL);

    final CarrierDisplayNameData cdnd = useCdnr
            ? mCdnr.getCarrierDisplayNameData()
            : getCarrierDisplayNameLegacy();

    final int subId = mPhone.getSubId();

    // Avoid sending unnecessary updates
    if (subId == mSubId && cdnd.equals(mCarrierDisplayNameData)) return;

    if (SubscriptionManager.isValidSubscriptionId(subId)) {
        mSubscriptionManagerService.setCarrierName(subId, getCarrierName(cdnd));
    }

    mCarrierDisplayNameData = cdnd;
    notifyCarrierDisplayNameDataChanged();
}
```

**方法逻辑**：

1. 读取 CarrierConfig 开关 `KEY_ENABLE_CARRIER_DISPLAY_NAME_RESOLVER_BOOL`，决定使用 CDNR 还是 Legacy
2. 调用对应的机制获取 `CarrierDisplayNameData`
3. 如果 subId 和显示数据均未变化，跳过更新
4. 更新 SubscriptionManager 中的运营商名称
5. 发送 Sticky Broadcast 通知上层

### 3.2 触发时机

`updateCarrierDisplayName()` 在以下场景被调用：

- 网络注册状态变化（`EVENT_POLL_STATE_DONE`）
- SIM 卡状态变化（`EVENT_SIM_READY` / `EVENT_RECORDS_LOADED`）
- CarrierConfig 变化
- IMS 注册状态变化
- WiFi Calling 状态变化
- 卫星模式状态变化

### 3.3 数据流总览

```
┌─────────────────────────────────────────────────────────────────┐
│                        触发条件                                  │
│  网络注册变化 / SIM卡变化 / CarrierConfig变化 / IMS状态变化       │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│     ServiceStateTracker.updateCarrierDisplayName()              │
│     ├─ 读取 CarrierConfig 开关                                   │
│     ├─ useCdnr=true  → mCdnr.getCarrierDisplayNameData()        │
│     └─ useCdnr=false → getCarrierDisplayNameLegacy()  ← 本文档聚焦 │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│              getCarrierDisplayNameLegacy()                       │
│     ├─ 获取 SPN（getServiceProviderName）                        │
│     ├─ 计算显示规则（getCarrierNameDisplayBitmask）               │
│     ├─ 判断场景（无服务/有服务/漫游/飞行模式/WFC/卫星等）          │
│     └─ 组装 CarrierDisplayNameData                               │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│           notifyCarrierDisplayNameDataChanged()                  │
│     └─ 发送 ACTION_SERVICE_PROVIDERS_UPDATED Sticky Broadcast   │
│         (EXTRA_SHOW_SPN, EXTRA_SPN, EXTRA_SHOW_PLMN, EXTRA_PLMN) │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                        上层消费方                                │
│     SystemUI（状态栏）/ Settings（设置页）/ 锁屏界面              │
└─────────────────────────────────────────────────────────────────┘
```

### 3.4 Legacy 与 CDNR 分支选择

```java
final boolean useCdnr = mCarrierConfig.getBoolean(
        CarrierConfigManager.KEY_ENABLE_CARRIER_DISPLAY_NAME_RESOLVER_BOOL);
```

- **Legacy 机制**：代码集中在 `ServiceStateTracker` 内部，逻辑复杂但一目了然
- **CDNR 机制**：将显示名称解析逻辑抽取到独立的 CarrierDisplayNameResolver 类中，支持多数据源优先级和更灵活的配置

本文档聚焦 Legacy 机制，即 `getCarrierDisplayNameLegacy()` 的完整代码路径。

---

## 第4章 SPN 的获取与来源优先级

### 4.1 getServiceProviderName() 完整分析

getServiceProviderName() 是获取 SPN 的核心方法：

```java
public String getServiceProviderName() {
    // BrandOverride has higher priority than the carrier config
    String operatorBrandOverride = getOperatorBrandOverride();
    if (!TextUtils.isEmpty(operatorBrandOverride)) {
        return operatorBrandOverride;
    }

    String carrierName = mIccRecords != null ? mIccRecords.getServiceProviderName() : "";
    if (mCarrierConfig.getBoolean(CarrierConfigManager.KEY_CARRIER_NAME_OVERRIDE_BOOL)
            || TextUtils.isEmpty(carrierName)) {
        return mCarrierConfig.getString(CarrierConfigManager.KEY_CARRIER_NAME_STRING);
    }

    return carrierName;
}
```

**SPN 来源优先级**（从高到低）：

```
┌─────────────────────────────────────────────┐
│  1. BrandOverride（运营商品牌覆盖）            │
│     └─ getOperatorBrandOverride()            │
├─────────────────────────────────────────────┤
│  2. SIM 卡 EF_SPN                            │
│     └─ mIccRecords.getServiceProviderName()  │
├─────────────────────────────────────────────┤
│  3. CarrierConfig 覆盖                       │
│     └─ KEY_CARRIER_NAME_OVERRIDE_BOOL        │
│     └─ KEY_CARRIER_NAME_STRING               │
└─────────────────────────────────────────────┘
```

### 4.2 BrandOverride

BrandOverride 是最高优先级的 SPN 来源：

```java
private String getOperatorBrandOverride() {
    UiccPort uiccPort = mPhone.getUiccPort();
    if (uiccPort == null) return null;
    UiccProfile profile = uiccPort.getUiccProfile();
    if (profile == null) return null;
    return profile.getOperatorBrandOverride();
}
```

当 BrandOverride 存在时，所有 PLMN 都被视为 HOME PLMN，且**只显示 SPN**（不显示 PLMN）。这是运营商定制 ROM 时覆盖默认运营商名称的常用手段。

### 4.3 SIM 卡 EF_SPN 读取流程

#### 4.3.1 FSM 状态机

SIMRecords 使用有限状态机（FSM）读取 SPN：

```java
private enum GetSpnFsmState {
    INIT,               // 初始状态
    READ_SPN_3GPP,      // 读取 EF_SPN（3GPP 标准）
    READ_SPN_CPHS,      // 读取 EF_SPN_CPHS（CPHS 标准）
    READ_SPN_SHORT_CPHS // 读取 EF_SPN_SHORT_CPHS
}
```

**读取顺序**：
1. 尝试读取 EF_SPN（3GPP 标准）
2. 如果 EF_SPN 为空，尝试读取 EF_SPN_CPHS
3. 如果 EF_SPN_CPHS 为空，尝试读取 EF_SPN_SHORT_CPHS
4. 找到第一个有效的 SPN 后停止

#### 4.3.2 EF_SPN 文件结构

根据 3GPP TS 31.102 section 4.2.12，EF_SPN 文件结构如下：

| 字节 | 内容 | 说明 |
|------|------|------|
| 第1字节 | Display Condition | 显示条件（bit0/bit1 决定 SPN/PLMN 显示规则） |
| 第2字节起 | SPN 字符串 | 使用 GSM 7-bit 编码或 UCS2 编码 |

#### 4.3.3 Display Condition 转换

convertSpnDisplayConditionToBitmask() 将 EF_SPN 第1字节转换为内部使用的 bitmask：

```java
public static int convertSpnDisplayConditionToBitmask(int condition) {
    int carrierNameDisplayCondition = 0;

    // b1 = 0: 在 HPLMN 或 SPDI 列表中的 PLMN 注册时，不显示 PLMN
    // b1 = 1: 在 HPLMN 或 SPDI 列表中的 PLMN 注册时，显示 PLMN
    if ((condition & 0x1) == 0x1) {
        carrierNameDisplayCondition |= CARRIER_NAME_DISPLAY_CONDITION_BITMASK_PLMN;
    }

    // b2 = 0: 在非 HPLMN 且非 SPDI 列表中的 PLMN 注册时，显示 SPN
    // b2 = 1: 在非 HPLMN 且非 SPDI 列表中的 PLMN 注册时，不显示 SPN
    if ((condition & 0x2) == 0) {
        carrierNameDisplayCondition |= CARRIER_NAME_DISPLAY_CONDITION_BITMASK_SPN;
    }

    return carrierNameDisplayCondition;
}
```

**转换对照表**：

| EF_SPN 第1字节 | b1 (bit0) | b2 (bit1) | 转换后 bitmask | 含义 |
|----------------|-----------|-----------|----------------|------|
| 0x00 | 0 | 0 | `SPN=1, PLMN=0` | 非漫游显示 SPN；HPLMN 不显示 PLMN |
| 0x01 | 1 | 0 | `SPN=1, PLMN=1` | 非漫游显示 SPN；HPLMN 显示 PLMN |
| 0x02 | 0 | 1 | `SPN=0, PLMN=0` | 非漫游不显示 SPN；HPLMN 不显示 PLMN |
| 0x03 | 1 | 1 | `SPN=0, PLMN=1` | 非漫游不显示 SPN；HPLMN 显示 PLMN |

### 4.4 CarrierConfig 覆盖

当 `KEY_CARRIER_NAME_OVERRIDE_BOOL` 为 true 或 SIM 卡 SPN 为空时，使用 CarrierConfig 中配置的 `KEY_CARRIER_NAME_STRING` 作为 SPN。

---

## 第5章 显示规则计算（getCarrierNameDisplayBitmask）

### 5.1 方法完整走读

getCarrierNameDisplayBitmask() 是计算显示规则的核心方法：

```java
@CarrierNameDisplayBitmask
public int getCarrierNameDisplayBitmask(ServiceState ss) {
    if (!TextUtils.isEmpty(getOperatorBrandOverride())) {
        // BrandOverride 存在时，所有 PLMN 视为 HOME PLMN，只显示 SPN
        return CARRIER_NAME_DISPLAY_BITMASK_SHOW_SPN;
    } else if (TextUtils.isEmpty(getServiceProviderName())) {
        // SPN 为空时，只显示 PLMN
        return CARRIER_NAME_DISPLAY_BITMASK_SHOW_PLMN;
    } else {
        // 正常情况：根据漫游状态和 SIM rule 计算
        boolean useRoamingFromServiceState = mCarrierConfig.getBoolean(
                CarrierConfigManager.KEY_SPN_DISPLAY_RULE_USE_ROAMING_FROM_SERVICE_STATE_BOOL);
        int carrierDisplayNameConditionFromSim =
                mIccRecords == null ? 0 : mIccRecords.getCarrierNameDisplayCondition();

        boolean isRoaming;
        if (useRoamingFromServiceState) {
            isRoaming = ss.getRoaming();
        } else {
            String[] hplmns = mIccRecords != null ? mIccRecords.getHomePlmns() : null;
            isRoaming = !ArrayUtils.contains(hplmns, ss.getOperatorNumeric());
        }

        int rule;
        if (isRoaming) {
            // 漫游状态：默认显示 PLMN
            rule = CARRIER_NAME_DISPLAY_BITMASK_SHOW_PLMN;

            // 根据 SIM rule 决定是否同时显示 SPN
            if ((carrierDisplayNameConditionFromSim
                    & CARRIER_NAME_DISPLAY_CONDITION_BITMASK_SPN)
                    == CARRIER_NAME_DISPLAY_CONDITION_BITMASK_SPN) {
                rule |= CARRIER_NAME_DISPLAY_BITMASK_SHOW_SPN;
            }
        } else {
            // 非漫游状态：默认显示 SPN
            rule = CARRIER_NAME_DISPLAY_BITMASK_SHOW_SPN;

            // 根据 SIM rule 决定是否同时显示 PLMN
            if ((carrierDisplayNameConditionFromSim
                    & CARRIER_NAME_DISPLAY_CONDITION_BITMASK_PLMN)
                    == CARRIER_NAME_DISPLAY_CONDITION_BITMASK_PLMN) {
                rule |= CARRIER_NAME_DISPLAY_BITMASK_SHOW_PLMN;
            }
        }
        return rule;
    }
}
```

### 5.2 四大分支分析

#### 分支1：BrandOverride 非空

```java
if (!TextUtils.isEmpty(getOperatorBrandOverride())) {
    return CARRIER_NAME_DISPLAY_BITMASK_SHOW_SPN; // 只显示 SPN
}
```

- **逻辑**：当运营商通过 BrandOverride 覆盖了默认名称时，所有网络都被视为 HOME 网络
- **结果**：`rule = 1`（只显示 SPN，不显示 PLMN）
- **对应思维导图**：`getOperatorBrandOverride 非空 → 只显示 SPN`

#### 分支2：SPN 为空

```java
else if (TextUtils.isEmpty(getServiceProviderName())) {
    return CARRIER_NAME_DISPLAY_BITMASK_SHOW_PLMN; // 只显示 PLMN
}
```

- **逻辑**：当 SIM 卡没有有效的 SPN 时，只能显示网络侧的 PLMN
- **结果**：`rule = 2`（只显示 PLMN，不显示 SPN）
- **对应思维导图**：`getServiceProviderName 空，即 spn 是空的 → 只显示 PLMN`

#### 分支3：漫游状态

```java
if (isRoaming) {
    rule = CARRIER_NAME_DISPLAY_BITMASK_SHOW_PLMN; // 默认显示 PLMN

    // 检查 SIM rule 是否要求在漫游时显示 SPN
    if ((carrierDisplayNameConditionFromSim & CARRIER_NAME_DISPLAY_CONDITION_BITMASK_SPN)
            == CARRIER_NAME_DISPLAY_CONDITION_BITMASK_SPN) {
        rule |= CARRIER_NAME_DISPLAY_BITMASK_SHOW_SPN;
    }
}
```

- **默认行为**：漫游时**必须显示 PLMN**（让用户知道当前连接的是哪家漫游运营商）
- **SPN 显示**：取决于 SIM rule 的 `CARRIER_NAME_DISPLAY_CONDITION_BITMASK_SPN` 位
  - 如果该位为 1 → 同时显示 SPN（`rule = 3`）
  - 如果该位为 0 → 只显示 PLMN（`rule = 2`）
- **对应思维导图**：`roaming 场景，sim rule 不显示 spn → 只显示 PLMN`

#### 分支4：非漫游状态

```java
else {
    rule = CARRIER_NAME_DISPLAY_BITMASK_SHOW_SPN; // 默认显示 SPN

    // 检查 SIM rule 是否要求在非漫游时显示 PLMN
    if ((carrierDisplayNameConditionFromSim & CARRIER_NAME_DISPLAY_CONDITION_BITMASK_PLMN)
            == CARRIER_NAME_DISPLAY_CONDITION_BITMASK_PLMN) {
        rule |= CARRIER_NAME_DISPLAY_BITMASK_SHOW_PLMN;
    }
}
```

- **默认行为**：非漫游时**默认显示 SPN**（显示用户熟悉的运营商名称）
- **PLMN 显示**：取决于 SIM rule 的 `CARRIER_NAME_DISPLAY_CONDITION_BITMASK_PLMN` 位
  - 如果该位为 1 → 同时显示 PLMN（`rule = 3`）
  - 如果该位为 0 → 只显示 SPN（`rule = 1`）
- **对应思维导图**：`非 roaming 场景，sim rule 显示 plmn → SPN 和 PLMN 都显示`

### 5.3 漫游判断逻辑

```java
boolean useRoamingFromServiceState = mCarrierConfig.getBoolean(
        CarrierConfigManager.KEY_SPN_DISPLAY_RULE_USE_ROAMING_FROM_SERVICE_STATE_BOOL);

boolean isRoaming;
if (useRoamingFromServiceState) {
    isRoaming = ss.getRoaming(); // 直接使用 ServiceState 中的 roaming 标志
} else {
    String[] hplmns = mIccRecords != null ? mIccRecords.getHomePlmns() : null;
    isRoaming = !ArrayUtils.contains(hplmns, ss.getOperatorNumeric()); // 通过 HPLMN 列表判断
}
```

两种漫游判断方式：
- **ServiceState roaming 标志**：Modem 直接上报的漫游状态
- **HPLMN 列表比对**：将当前注册的 PLMN 与 SIM 卡的 HPLMN/EHPLMN 列表比对，不一致则视为漫游

### 5.4 规则计算流程图

```
getCarrierNameDisplayBitmask()
        │
        ├─ BrandOverride 非空？
        │   └─ YES → return SHOW_SPN (rule=1)
        │
        ├─ SPN 为空？
        │   └─ YES → return SHOW_PLMN (rule=2)
        │
        └─ 正常情况
            │
            ├─ 计算 isRoaming
            │   ├─ useRoamingFromServiceState=true → ss.getRoaming()
            │   └─ useRoamingFromServiceState=false → !HPLMN.contains(currentPLMN)
            │
            ├─ isRoaming=true？
            │   ├─ YES → rule = SHOW_PLMN
            │   │        ├─ SIM rule SPN bit=1 → rule |= SHOW_SPN (rule=3)
            │   │        └─ SIM rule SPN bit=0 → rule 保持 2
            │   └─ NO  → rule = SHOW_SPN
            │             ├─ SIM rule PLMN bit=1 → rule |= SHOW_PLMN (rule=3)
            │             └─ SIM rule PLMN bit=0 → rule 保持 1
            │
            └─ return rule
```

---

## 第6章 场景分析（getCarrierDisplayNameLegacy 分支）

getCarrierDisplayNameLegacy() 是 Legacy 机制的核心方法，根据当前网络状态和服务场景，计算最终的 SPN/PLMN 显示内容。

### 6.1 方法结构概览

```java
private @NonNull CarrierDisplayNameData getCarrierDisplayNameLegacy() {
    // 1. 预计算 WFC 相关格式字符串
    String wfcVoiceSpnFormat = null;
    String wfcDataSpnFormat = null;
    String wfcFlightSpnFormat = null;
    // ... WFC 检测和格式获取

    // 2. 预计算 Cross-SIM Calling 格式字符串
    String crossSimSpnFormat = null;
    // ... Cross-SIM 检测

    // 3. 预计算卫星网络名称
    String satellitePlmn = null;
    // ... 卫星检测

    // 4. 主分支：GSM vs CDMA
    if (mPhone.isPhoneTypeGsm()) {
        // GSM 逻辑（见 6.2-6.8）
    } else {
        // CDMA 逻辑（见第7章）
    }

    // 5. 组装 CarrierDisplayNameData
    return new CarrierDisplayNameData.Builder()
            .setSpn(spn)
            .setDataSpn(dataSpn)
            .setShowSpn(showSpn)
            .setPlmn(plmn)
            .setShowPlmn(showPlmn)
            .build();
}
```

### 6.2 不插卡场景

当没有插入 SIM 卡时：

- `mIccRecords == null`
- getServiceProviderName() 返回空
- getCarrierNameDisplayBitmask() 进入分支2：`SPN 为空 → return SHOW_PLMN`
- 最终只显示 PLMN（网络侧返回的运营商名称）

如果同时无服务：
- `combinedRegState == STATE_OUT_OF_SERVICE`
- 显示 "No service" 或 "Emergency call only"

### 6.3 插卡无服务场景

当 `combinedRegState == STATE_OUT_OF_SERVICE || STATE_EMERGENCY_ONLY` 时：

```java
showPlmn = true; // 强制显示 PLMN

// 判断是否有紧急呼叫能力
final boolean forceDisplayNoService = shouldForceDisplayNoService() && !mIsSimReady;
if (!forceDisplayNoService && (mEmergencyOnly || Phone.isEmergencyCallOnly())) {
    // 有紧急呼叫能力
    plmn = "Emergency call only";
} else {
    // 完全无服务
    plmn = "No service";
    noService = true;
}
```

**SPN 处理**：
```java
spn = getServiceProviderName();
dataSpn = spn;
showSpn = !noService && !TextUtils.isEmpty(spn)
        && ((rule & CARRIER_NAME_DISPLAY_BITMASK_SHOW_SPN)
        == CARRIER_NAME_DISPLAY_BITMASK_SHOW_SPN);
```

- 如果 `noService = true`（完全无服务），强制 `showSpn = false`
- 否则根据 rule 判断是否显示 SPN

### 6.4 插卡有服务（非漫游）场景

当 `combinedRegState == STATE_IN_SERVICE` 且非漫游时：

```java
plmn = mSS.getOperatorAlpha(); // 获取网络侧运营商名称
showPlmn = !TextUtils.isEmpty(plmn) &&
        ((rule & CARRIER_NAME_DISPLAY_BITMASK_SHOW_PLMN)
                == CARRIER_NAME_DISPLAY_BITMASK_SHOW_PLMN);
```

```java
spn = getServiceProviderName();
dataSpn = spn;
showSpn = !noService && !TextUtils.isEmpty(spn)
        && ((rule & CARRIER_NAME_DISPLAY_BITMASK_SHOW_SPN)
        == CARRIER_NAME_DISPLAY_BITMASK_SHOW_SPN);
```

**显示结果**：

| rule | showSpn | showPlmn | 显示效果 |
|------|---------|----------|----------|
| 1 | true | false | 只显示 SPN |
| 2 | false | true | 只显示 PLMN |
| 3 | true | true | 同时显示 SPN 和 PLMN |

### 6.5 漫游场景

当 `isRoaming = true` 时：

- `getCarrierNameDisplayBitmask()` 默认返回 `SHOW_PLMN`
- SPN 是否显示取决于 SIM rule 的 `CARRIER_NAME_DISPLAY_CONDITION_BITMASK_SPN` 位

```java
if (isRoaming) {
    rule = CARRIER_NAME_DISPLAY_BITMASK_SHOW_PLMN; // 默认显示 PLMN

    if ((carrierDisplayNameConditionFromSim & CARRIER_NAME_DISPLAY_CONDITION_BITMASK_SPN)
            == CARRIER_NAME_DISPLAY_CONDITION_BITMASK_SPN) {
        rule |= CARRIER_NAME_DISPLAY_BITMASK_SHOW_SPN; // 同时显示 SPN
    }
}
```

**对应思维导图**：`roaming 场景，sim rule 不显示 spn → 只显示 PLMN`

### 6.6 飞行模式场景

当 `combinedRegState == STATE_POWER_OFF` 时：

```java
showPlmn = true;
plmn = null; // 飞行模式下 PLMN 显示为 null
```

同时：
```java
if (mSS.getState() == ServiceState.STATE_POWER_OFF
        || (showPlmn && TextUtils.equals(spn, plmn))) {
    // 飞行模式或 SPN 等于 PLMN，不显示 SPN
    spn = null;
    showSpn = false;
}
```

**显示效果**：状态栏不显示运营商名称（或显示空）

### 6.7 WiFi Calling（WFC）场景

#### 6.7.1 检测条件

```java
if (mPhone.getImsPhone() != null && mPhone.getImsPhone().isWifiCallingEnabled()
        && mPhone.isImsRegistered()
        && (combinedRegState == ServiceState.STATE_IN_SERVICE
        && mSS.getDataNetworkType() == TelephonyManager.NETWORK_TYPE_IWLAN)) {
    // 进入 WFC 处理逻辑
}
```

**四个条件同时满足**：
1. IMS Phone 存在
2. WiFi Calling 已启用
3. IMS 已注册
4. 数据网络类型为 IWLAN（即通过 WiFi 承载）

#### 6.7.2 格式字符串获取

从 CarrierConfig 和系统资源中获取格式化字符串：

```java
voiceIdx = mCarrierConfig.getInt(CarrierConfigManager.KEY_WFC_SPN_FORMAT_IDX_INT);
dataIdx = mCarrierConfig.getInt(CarrierConfigManager.KEY_WFC_DATA_SPN_FORMAT_IDX_INT);
flightModeIdx = mCarrierConfig.getInt(
        CarrierConfigManager.KEY_WFC_FLIGHT_MODE_SPN_FORMAT_IDX_INT);

String[] wfcSpnFormats = SubscriptionManager.getResourcesForSubId(mPhone.getContext(),
        mPhone.getSubId(), useRootLocale)
        .getStringArray(com.android.internal.R.array.wfcSpnFormats);

wfcVoiceSpnFormat = wfcSpnFormats[voiceIdx];
wfcDataSpnFormat = wfcSpnFormats[dataIdx];
wfcFlightSpnFormat = wfcSpnFormats[flightModeIdx];
```

典型的 `wfcSpnFormats` 数组内容（以英文为例）：
```
["%s", "%s Wi-Fi Calling", "%s WFC", "%s via Wi-Fi"]
```

#### 6.7.3 WFC 下的名称格式化

**场景 A：有有效 SPN**

```java
if (!TextUtils.isEmpty(spn) && !TextUtils.isEmpty(wfcVoiceSpnFormat)
        && !TextUtils.isEmpty(wfcDataSpnFormat)) {
    // 处理飞行模式
    if (mSS.getState() == ServiceState.STATE_POWER_OFF) {
        wfcVoiceSpnFormat = wfcFlightSpnFormat;
    }

    String originalSpn = spn.trim();
    spn = String.format(wfcVoiceSpnFormat, originalSpn);      // 如 "中国移动 Wi-Fi Calling"
    dataSpn = String.format(wfcDataSpnFormat, originalSpn);   // 如 "中国移动 WFC"
    showSpn = true;
    showPlmn = false; // WFC 模式下不显示 PLMN
}
```

**场景 B：没有有效 SPN，但有 PLMN**

```java
else if (!TextUtils.isEmpty(plmn) && !TextUtils.isEmpty(wfcVoiceSpnFormat)) {
    String originalPlmn = plmn.trim();

    // 可选：使用 PNN（PLMN Network Name）覆盖
    if (mIccRecords != null && mCarrierConfig.getBoolean(
            CarrierConfigManager.KEY_WFC_CARRIER_NAME_OVERRIDE_BY_PNN_BOOL)) {
        originalPlmn = mIccRecords.getPnnHomeName();
    }

    plmn = String.format(wfcVoiceSpnFormat, originalPlmn); // 如 "CMCC Wi-Fi Calling"
}
```

#### 6.7.4 WFC 场景总结

| 条件 | 显示内容 | showSpn | showPlmn |
|------|----------|---------|----------|
| 有 SPN | `String.format(format, SPN)` | true | false |
| 无 SPN，有 PLMN | `String.format(format, PLMN)` | false | true |
| 飞行模式 | 使用 flightModeFormat | - | - |

### 6.8 卫星（Satellite）场景

```java
String satellitePlmn = null;
SatelliteModemStateListener satelliteModemStateListener = getSatelliteModemStateListener();
if (satelliteModemStateListener != null
        && satelliteModemStateListener.isInConnectedState()) {
    satellitePlmn = getSatelliteDisplayName();
}
```

当卫星模式激活时：

```java
if (!TextUtils.isEmpty(satellitePlmn)) {
    plmn = satellitePlmn;    // 用卫星网络名称覆盖 PLMN
    showPlmn = true;         // 强制显示 PLMN
    showSpn = false;         // 不显示 SPN
}
```

**特点**：
- 卫星网络名称优先级最高，覆盖所有其他名称
- 只显示卫星 PLMN，不显示 SPN

### 6.9 Cross-SIM Calling 场景

#### 6.9.1 检测条件

```java
if ((getImsRegistrationTech() == ImsRegistrationImplBase.REGISTRATION_TECH_CROSS_SIM)
        && mPhone.isImsRegistered()) {
    // 进入 Cross-SIM Calling 处理逻辑
}
```

#### 6.9.2 格式字符串获取

```java
int crossSimSpnFormatIdx = mCarrierConfig.getInt(
        CarrierConfigManager.KEY_CROSS_SIM_SPN_FORMAT_INT);
String[] crossSimSpnFormats = SubscriptionManager.getResourcesForSubId(
        mPhone.getContext(), mPhone.getSubId(), useRootLocale)
        .getStringArray(R.array.crossSimSpnFormats);
crossSimSpnFormat = crossSimSpnFormats[crossSimSpnFormatIdx];
```

#### 6.9.3 Cross-SIM 下的名称格式化

**场景 A：有有效 SPN**

```java
if (!TextUtils.isEmpty(spn)) {
    String originalSpn = spn.trim();
    spn = String.format(crossSimSpnFormat, originalSpn); // 如 "中国移动 (Cross-SIM)"
    dataSpn = spn;
    showSpn = true;
    showPlmn = false;
}
```

**场景 B：没有有效 SPN**

```java
else if (!TextUtils.isEmpty(plmn)) {
    String originalPlmn = plmn.trim();
    if (mIccRecords != null && mCarrierConfig.getBoolean(
            CarrierConfigManager.KEY_WFC_CARRIER_NAME_OVERRIDE_BY_PNN_BOOL)) {
        originalPlmn = mIccRecords.getPnnHomeName();
    }
    plmn = String.format(crossSimSpnFormat, originalPlmn);
}
```

### 6.10 场景处理优先级

在同一个 `getCarrierDisplayNameLegacy()` 调用中，多个特殊场景可能同时满足，处理优先级如下：

```
1. 卫星（Satellite）—— 最高优先级，覆盖所有其他名称
2. Cross-SIM Calling
3. WiFi Calling（WFC）
4. 正常场景（无服务/有服务/漫游/飞行模式）
```

代码中的判断顺序：

```java
if (!TextUtils.isEmpty(satellitePlmn)) {
    // 卫星处理
} else if (!TextUtils.isEmpty(crossSimSpnFormat)) {
    // Cross-SIM 处理
} else if (!TextUtils.isEmpty(spn) && !TextUtils.isEmpty(wfcVoiceSpnFormat)
        && !TextUtils.isEmpty(wfcDataSpnFormat)) {
    // WFC 有 SPN 处理
} else if (!TextUtils.isEmpty(plmn) && !TextUtils.isEmpty(wfcVoiceSpnFormat)) {
    // WFC 无 SPN 处理
} else if (mSS.getState() == ServiceState.STATE_POWER_OFF
        || (showPlmn && TextUtils.equals(spn, plmn))) {
    // 飞行模式或 SPN=PLMN
}
```

---

## 第7章 CDMA 特殊处理

当 `mPhone.isPhoneTypeGsm() == false` 时，进入 CDMA 处理分支：

```java
} else {
    // CDMA 逻辑
    String eriText = getOperatorNameFromEri();
    if (eriText != null) mSS.setOperatorAlphaLong(eriText);

    // carrier config gets a priority over ERI
    updateOperatorNameFromCarrierConfig();

    plmn = mSS.getOperatorAlpha();
    showPlmn = plmn != null;

    // WFC 处理
    if (!TextUtils.isEmpty(plmn) && !TextUtils.isEmpty(wfcVoiceSpnFormat)) {
        String originalPlmn = plmn.trim();
        plmn = String.format(wfcVoiceSpnFormat, originalPlmn);
    } else if (mCi.getRadioState() == TelephonyManager.RADIO_POWER_OFF) {
        plmn = null;
    }

    // 无服务处理
    if (combinedRegState == ServiceState.STATE_OUT_OF_SERVICE) {
        plmn = "No service";
    }
}
```

### 7.1 ERI 文本

getOperatorNameFromEri() 获取 CDMA 的 ERI（Enhanced Roaming Indicator）文本：

- CDMA 网络使用 ERI 来表示漫游状态
- ERI 文本从 `mPhone.getCdmaEriText()` 获取
- 不同 ERI 值对应不同的显示文本（如 "Roaming"、"Verizon Wireless" 等）

### 7.2 CarrierConfig 覆盖

updateOperatorNameFromCarrierConfig() 在 CDMA 网络下，如果配置了 `KEY_CDMA_HOME_REGISTERED_PLMN_NAME_OVERRIDE_BOOL`，则使用配置的名称覆盖 ERI 文本。

### 7.3 CDMA vs GSM 差异

| 特性 | GSM | CDMA |
|------|-----|------|
| SPN 来源 | SIM EF_SPN | RUIM/CSIM |
| PLMN 来源 | 网络注册 | ERI 文本 |
| 漫游判断 | HPLMN 列表 | SID/NID 匹配 |
| 显示规则 | SIM rule bitmask | ERI 配置 |

---

## 第8章 Intent 广播与上层消费

### 8.1 Sticky Broadcast 发送

notifyCarrierDisplayNameDataChanged() 发送 Sticky Broadcast：

```java
private void notifyCarrierDisplayNameDataChanged() {
    Intent intent = new Intent(TelephonyManager.ACTION_SERVICE_PROVIDERS_UPDATED);
    intent.putExtra(TelephonyManager.EXTRA_SHOW_SPN, mCarrierDisplayNameData.shouldShowSpn());
    intent.putExtra(TelephonyManager.EXTRA_SPN, mCarrierDisplayNameData.getSpn());
    intent.putExtra(TelephonyManager.EXTRA_DATA_SPN, mCarrierDisplayNameData.getDataSpn());
    intent.putExtra(TelephonyManager.EXTRA_SHOW_PLMN, mCarrierDisplayNameData.shouldShowPlmn());
    intent.putExtra(TelephonyManager.EXTRA_PLMN, mCarrierDisplayNameData.getPlmn());
    SubscriptionManager.putPhoneIdAndSubIdExtra(intent, mPhone.getPhoneId());
    mPhone.getContext().sendStickyBroadcastAsUser(intent, UserHandle.ALL);
}
```

### 8.2 Intent Extra 字段

| Extra 字段 | 类型 | 说明 |
|-----------|------|------|
| `EXTRA_SHOW_SPN` | boolean | 是否显示 SPN |
| `EXTRA_SPN` | String | SPN 内容 |
| `EXTRA_DATA_SPN` | String | 数据 SPN 内容 |
| `EXTRA_SHOW_PLMN` | boolean | 是否显示 PLMN |
| `EXTRA_PLMN` | String | PLMN 内容 |

### 8.3 上层消费方

**SystemUI（状态栏）**：
- 注册 `ACTION_SERVICE_PROVIDERS_UPDATED` 广播接收器
- 根据 `EXTRA_SHOW_SPN` / `EXTRA_SHOW_PLMN` 决定显示内容
- 典型显示格式：`SPN` 或 `PLMN` 或 `SPN - PLMN`

**Settings（设置页）**：
- 在 "关于手机" → "SIM 状态" 中显示当前运营商名称
- 使用 TelephonyManager.getNetworkOperatorName() 获取

**锁屏界面**：
- 显示当前运营商名称在锁屏底部
- 无服务时显示 "No service" 或 "Emergency call only"

---

## 第9章 调试与日志

### 9.1 LocalLog

ServiceStateTracker 使用 mCdnrLogs LocalLog 记录运营商名称变化历史：

```java
private final LocalLog mCdnrLogs = new LocalLog(64);
```

### 9.2 关键日志关键字

| 日志关键字 | 说明 |
|-----------|------|
| `updateCarrierDisplayName` | 运营商名称更新入口 |
| `getCarrierDisplayNameLegacy` | Legacy 机制开始/结束 |
| `rawPlmn` | 原始 PLMN 值 |
| `rawSpn` | 原始 SPN 值 |
| `CarrierName from EF` | CDNR 机制解析结果 |
| `ResolveCarrierDisplayName` | CDNR 最终解析结果 |
| `notifyCarrierDisplayNameDataChanged` | 发送广播通知 |

### 9.3 dumpsys 查看状态

```bash
# 查看 TelephonyRegistry 状态
adb shell dumpsys telephony.registry

# 查看 ServiceStateTracker 日志
adb shell dumpsys telephony.registry | grep -A 20 "ServiceStateTracker"

# 查看 CDNR 日志
adb shell dumpsys telephony.registry | grep -A 20 "CDNR"
```

### 9.4 日志级别控制

ServiceStateTracker 中的调试开关：

```java
static final boolean DBG = true;   // 详细日志
static final boolean VDBG = false; // 超详细日志（STOPSHIP if true）
```

---

## 附录 A：思维导图与代码完整对照

| 思维导图节点 | 对应代码 | 说明 |
|-------------|---------|------|
| **PLMN** | `mSS.getOperatorAlpha()` | RIL 消息 operator 字段 |
| **SPN** | `getServiceProviderName()` | SIM 卡 EF_SPN 文件 |
| **rule SHOW_SPN** | `CARRIER_NAME_DISPLAY_BITMASK_SHOW_SPN` | 显示规则 bit0 |
| **rule SHOW_PLMN** | `CARRIER_NAME_DISPLAY_BITMASK_SHOW_PLMN` | 显示规则 bit1 |
| **sim rule PLMN** | `CARRIER_NAME_DISPLAY_CONDITION_BITMASK_PLMN` | SIM rule bit0 |
| **sim rule SPN** | `CARRIER_NAME_DISPLAY_CONDITION_BITMASK_SPN` | SIM rule bit1 |
| **不插卡** | `mIccRecords == null` | SPN 为空，只显示 PLMN |
| **插卡无服务-紧急呼叫** | `mEmergencyOnly` | 显示 "Emergency call only" |
| **插卡无服务-无紧急呼叫** | `!mEmergencyOnly` | 显示 "No service" |
| **插卡有服务-非漫游** | `!isRoaming` | 默认显示 SPN |
| **漫游** | `isRoaming` | 默认显示 PLMN |
| **飞行模式** | `STATE_POWER_OFF` | showPlmn=true, plmn=null |
| **WFC** | `NETWORK_TYPE_IWLAN` | 格式化 SPN/PLMN + Wi-Fi Calling |
| **卫星** | `satellitePlmn` | 覆盖所有名称 |
| **Cross-SIM** | `REGISTRATION_TECH_CROSS_SIM` | 格式化 SPN/PLMN + Cross-SIM |

---

## 附录 B：关键文件索引

| 文件 | 作用 |
|------|------|
| ServiceStateTracker.java | 核心入口，updateCarrierDisplayName / getCarrierDisplayNameLegacy / getCarrierNameDisplayBitmask / getServiceProviderName |
| IccRecords.java | CARRIER_NAME_DISPLAY 常量定义，convertSpnDisplayConditionToBitmask |
| SIMRecords.java | EF_SPN 读取 FSM，getServiceProviderName |
| CarrierDisplayNameData.java | 显示结果数据结构 |
| ServiceState.java | mOperatorAlphaLong/Short/Numeric |
| TelephonyManager.java | 对外 API，ACTION_SERVICE_PROVIDERS_UPDATED |
