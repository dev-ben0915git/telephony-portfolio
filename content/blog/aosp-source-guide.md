---
title: "技术博客源码环境搭建指南"
date: "2025-06-22"
summary: "本博客所有技术分析文章均基于 AOSP（Android Open Source Project）源码。本文档列出所需的 7 个源码仓库及其克隆命令，方便读者搭建本地源码环境，对照博客内容进行阅读和验证。"
category: "source-env"
tags: ["AOSP", "源码环境", "Telephony", "RIL", "Framework", "IMS"]
featured: false
---

> 本博客所有技术分析文章均基于 **AOSP（Android Open Source Project）** 源码，代码引用均来自以下仓库。
> 建议读者在本地克隆对应仓库，以便对照博客内容进行阅读和验证。

---

## 一、源码仓库列表

以下 7 个仓库涵盖了本博客涉及的所有模块，从 Telephony Framework 到 RIL 层、从通话应用到 IMS 子系统。

### 1. frameworks/opt/telephony

Telephony 框架核心模块，包含 ServiceStateTracker、Phone、Call 等 Telephony 核心类的实现。

```bash
git clone https://mirrors.tuna.tsinghua.edu.cn/git/AOSP/platform/frameworks/opt/telephony
```

**涉及文章**：全部博客文章（核心仓库）

### 2. frameworks/base

Android 基础框架，包含 `android.telephony` 公共 API 定义、ServiceState 等数据类。

```bash
git clone https://mirrors.tuna.tsinghua.edu.cn/git/AOSP/platform/frameworks/base
```

**涉及文章**：开机驻网全流程梳理、运营商名称显示机制详解

### 3. packages/services/Telephony

Telephony 应用层服务，包含 TeleService、TelephonyProvider 等系统应用。

```bash
git clone https://mirrors.tuna.tsinghua.edu.cn/git/AOSP/platform/packages/services/Telephony
```

**涉及文章**：开机驻网全流程梳理、运营商名称显示机制详解

### 4. packages/services/Telecomm

Telecom 框架服务，负责通话路由、ConnectionService 管理等通话核心逻辑。

```bash
git clone https://mirrors.tuna.tsinghua.edu.cn/git/AOSP/platform/packages/services/Telecomm
```

**涉及文章**：通话模块基本架构梳理

### 5. packages/apps/Dialer

Android 原生拨号应用，展示通话 UI 层的实现。

```bash
git clone https://mirrors.tuna.tsinghua.edu.cn/git/AOSP/platform/packages/apps/Dialer
```

**涉及文章**：通话模块基本架构梳理

### 6. frameworks/opt/net/ims

IMS（IP Multimedia Subsystem）框架，负责 VoLTE、WiFi Calling 等 IMS 通话功能。

```bash
git clone https://mirrors.tuna.tsinghua.edu.cn/git/AOSP/platform/frameworks/opt/net/ims
```

**涉及文章**：通话模块基本架构梳理

### 7. hardware/ril

RIL（Radio Interface Layer）硬件抽象层，负责 Framework 与 Modem 之间的通信。

```bash
git clone https://mirrors.tuna.tsinghua.edu.cn/git/AOSP/platform/hardware/ril
```

**涉及文章**：开机驻网全流程梳理、运营商名称显示机制详解

---

## 二、一键克隆脚本

将以下内容保存为 `clone-aosp.sh`，在目标目录下执行即可一次性克隆全部仓库：

```bash
#!/bin/bash
MIRROR="https://mirrors.tuna.tsinghua.edu.cn/git/AOSP/platform"

repos=(
  "frameworks/opt/telephony"
  "frameworks/base"
  "packages/services/Telephony"
  "packages/services/Telecomm"
  "packages/apps/Dialer"
  "frameworks/opt/net/ims"
  "hardware/ril"
)

for repo in "${repos[@]}"; do
  echo ">>> Cloning $repo ..."
  git clone "$MIRROR/$repo"
  echo ""
done

echo "All repositories cloned successfully."
```

---

## 三、克隆后的目录结构

```
<你的工作目录>/
├── frameworks/
│   ├── base/                  # android.telephony 公共 API
│   └── opt/
│       ├── telephony/        # Telephony Framework 核心
│       └── net/
│           └── ims/          # IMS/VoLTE 框架
├── packages/
│   ├── apps/
│   │   └── Dialer/           # 拨号应用
│   └── services/
│       ├── Telephony/        # TeleService / TelephonyProvider
│       └── Telecomm/         # Telecom 服务
└── hardware/
    └── ril/                  # RIL 硬件抽象层
```

---

## 四、源码阅读建议

1. **使用 Android Studio**：直接用 Android Studio 打开单个仓库（如 `frameworks/opt/telephony`），可享受代码跳转、搜索、引用查找等功能
2. **关键代码路径速查**：

   | 模块 | 关键路径 |
   |------|---------|
   | ServiceStateTracker | `telephony/src/java/com/android/internal/telephony/ServiceStateTracker.java` |
   | Phone 基类 | `telephony/src/java/com/android/internal/telephony/Phone.java` |
   | SIM 卡记录 | `telephony/src/java/com/android/internal/telephony/uicc/` |
   | CDNR | `telephony/src/java/com/android/internal/telephony/cdnr/` |
   | Telecom 服务 | `Telecomm/src/com/android/server/telecom/` |
   | RIL 接口 | `ril/src/java/com/android/internal/telephony/` |
   | ServiceState API | `base/telephony/java/android/telephony/ServiceState.java` |

3. **源码版本**：本博客文章基于 **master 分支** 分析，建议切换到最新的 `origin/android17-release` 分支进行对照阅读。
