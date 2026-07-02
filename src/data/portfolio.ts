import type { TimelineItem, ProjectItem, SkillMatrixGroup } from '@/types';

export const skills: SkillMatrixGroup[] = [
  {
    key: 'telephony-core',
    title: 'Telephony 核心模块',
    description: '覆盖搜网、数据业务、通话管理、短彩信、TelephonyProvider 与 SIM 卡账户管理。',
    skills: [
      { name: '搜网全流程 / 驻网性能优化', level: 92 },
      { name: '数据业务 / 5G 数据断连定位', level: 88 },
      { name: 'TeleService / Telecom / IMS 通话管理', level: 86 },
      { name: '短彩信 / TelephonyProvider', level: 80 },
      { name: 'SIM 卡账户 / 多卡场景', level: 82 },
    ],
  },
  {
    key: 'platform',
    title: '平台适配 / Framework',
    description: '高通、MTK、海思平台适配，AOSP Framework 定制与多代 Android ROM 升级。',
    skills: [
      { name: '高通平台 Telephony 适配', level: 88 },
      { name: 'MTK 平台 Telephony 适配', level: 86 },
      { name: '海思平台通信模块适配', level: 82 },
      { name: 'AOSP Framework 层定制', level: 88 },
      { name: 'Android R/S/T/U/W 版本升级', level: 90 },
    ],
  },
  {
    key: 'delivery',
    title: '版本交付 / 认证',
    description: '从需求评审、方案设计、编码实现到测试验证、客户验收与量产交付。',
    skills: [
      { name: '客户定制需求全流程交付', level: 92 },
      { name: 'Telephony CTS 认证适配', level: 86 },
      { name: '国内三大运营商送测认证', level: 84 },
      { name: '海外运营商入网 / Carrier Config', level: 80 },
      { name: '量产问题闭环 / 舆情收敛', level: 88 },
    ],
  },
  {
    key: 'collaboration',
    title: '项目协同 / 问题攻坚',
    description: '面向旗舰客户项目的技术接口、故障攻关、跨团队协作与节点管理。',
    skills: [
      { name: '客户对接 / 对外技术接口', level: 90 },
      { name: '高优先级通信故障攻关', level: 88 },
      { name: '跨团队联调 / 测试验证', level: 86 },
      { name: '版本节点管理 / 零延误交付', level: 90 },
      { name: '复盘沉淀 / 技术方案输出', level: 84 },
    ],
  },
];

export const timeline: TimelineItem[] = [
  {
    year: '2020.09 — 2026.07',
    title: 'Telephony 开发工程师',
    org: '武汉中科创达软件股份有限公司 · 手机终端方向',
    description: '负责高通 / MTK / 海思平台 Android Telephony 框架层需求开发、问题修复、性能调优与 ROM 版本交付。',
    highlights: [
      '支撑华为、荣耀、OPPO、诺基亚等头部终端项目量产交付与版本迭代',
      '累计支撑 12+ 旗舰机型 ROM 版本从 Android S 到 Android W 跨代升级，项目按时交付零延误',
      '独立承接客户定制化通信功能需求，覆盖评审、设计、开发、验证、上线全流程，交付通过率 100%',
    ],
  },
  {
    year: '2024.03 — 至今',
    title: '华为鸿蒙 4.x 系统 ROM 升级',
    org: '通信互联组',
    description: '适配头部客户新一代终端产品通信性能升级需求，解决搜网、数据业务核心痛点并保障版本交付质量。',
    highlights: [
      '独立负责 Radio 服务 AIDL 升级，梳理 30+ 原有接口逻辑并完成兼容性适配',
      '攻坚搜网、数据业务高优先级故障 15+，解决开机驻网慢、5G 数据断连等核心问题',
      '提前 1 周完成全部开发与验证，支撑客户产品通过量产测试，多次获得部门季度优秀项目表彰',
    ],
  },
  {
    year: '2023.09 — 2024.02',
    title: 'OPPO Android U 系统 ROM 升级',
    org: '通话模块组',
    description: '支撑 OPPO Android U 版本多机型通话模块开发维护，覆盖 TeleService、Telecom、InCallUI 等核心模块。',
    highlights: [
      '负责通话全链路模块开发维护，修复通话类故障 30+',
      '跟进客户定制需求、问题定位、联调验证与版本交付',
      '项目按期交付，客户需求满足率 100%，获得客户官方邮件表扬',
    ],
  },
  {
    year: '2021.03 — 2023.07',
    title: '荣耀旗舰全系列 ROM 升级项目',
    org: '通信框架组',
    description: '支撑荣耀数字系列、V 系列、Magic 旗舰全系列机型 Android R 到 U 版本 ROM 升级，保障通信功能稳定迭代。',
    highlights: [
      '担任搜网与 Phone 稳定性对外唯一技术接口人，累计响应客户需求与问题反馈 100+',
      '主导 ROM 升级搜网模块适配，完成搜网制式、信号显示重构及国内 5G 异网漫游功能落地',
      '攻克开机驻网慢、信号显示异常、Phone 进程崩溃等核心问题 20+，通信功能零重大线上故障',
    ],
  },
  {
    year: '2020.09 — 2021.02',
    title: '诺基亚手机 ROM 升级项目',
    org: '通信协议组',
    description: '面向海外市场 ROM 迭代升级整机交付，满足不同区域运营商定制化通信规范与网络适配要求。',
    highlights: [
      '完成 Carrier Config、紧急号码规则、VoWiFi、基础通话等模块适配验证',
      '协同测试与运维团队定位海外通信兼容性问题，输出修复方案并跟进落地验证',
      '支撑产品按时通过海外运营商入网认证并进入量产阶段，无需求遗漏与线上遗留问题',
    ],
  },
  {
    year: '2016.09 — 2020.06',
    title: '软件工程 · 统招本科',
    org: '武汉工程大学',
    description: '本科阶段学习软件工程、Android 开发、网络通信与系统设计，为后续移动终端通信方向打下工程基础。',
    highlights: ['2020 年开始从事 Android Telephony 开发，长期深耕移动通信底层技术'],
  },
];

export const projects: ProjectItem[] = [
  {
    title: '华为鸿蒙 4.x ROM 升级通信适配',
    subtitle: 'Radio AIDL 升级 + 搜网 / 数据业务高优故障攻坚 + 通话 / 短信系统适配',
    period: '2024.03 — 至今',
    stack: ['Android Framework', 'Radio AIDL', 'Telephony', '搜网', '数据业务', '通话', '短信'],
    situation:
      '头部客户新一代终端产品需要完成通信性能升级与 ROM 适配，鸿蒙 4.2.1 系统（S->U）支撑华为智选国内多个新产品落地，鸿蒙 4.3.3 系统（S->W）支撑海外多个旗舰和 nova 系列新产品落地，存量版本存在搜网、数据业务等核心痛点，直接影响量产测试与版本交付质量。',
    task:
      '独立负责华为自研 Radio 服务 AIDL 升级与通信模块兼容性适配，攻坚搜网、数据业务重难点问题，同时完成通话模块和短信模块 AOSP 大版本升级系统适配，保障客户产品按节点通过量产测试并支撑新品上市。',
    action:
      '鸿蒙 4.2.1 系统：梳理 30+ 原有 Radio 接口逻辑，逐项完成 AIDL 兼容性适配；围绕搜网、数据业务建立问题复现、日志分析、模块归因、修复验证闭环；专项攻坚开机驻网慢与数据业务断连问题，保障 phone 进程和通话模块稳定性。鸿蒙 4.3.3 系统：完成通话模块和短信模块 AOSP 大版本升级系统适配。',
    result:
      '协助协议共同提前 1 周完成 AIDL 升级需求，支撑客户产品顺利通过量产测试；协助通信协议模块完成国内各大运营商送测认证，多个智选产品上市无通信模块舆情问题；多次获得客户书面表扬与月度之星表彰。',
    metrics: [
      { label: 'Radio 接口梳理', value: '30+', delta: 'AIDL 兼容适配' },
      { label: '高优故障攻坚', value: '15+', delta: '搜网 / 数据业务' },
      { label: '交付节点', value: '提前 1 周', delta: '开发与验证完成' },
      { label: '项目认可', value: '多次表彰', delta: '月度之星 + 客户书面表扬' },
    ],
    snippets: [
      {
        lang: 'java',
        caption: 'Radio AIDL 升级：接口兼容适配思路（去敏示例）',
        code: `// RadioServiceAdapter.java
RadioResponseInfo normalizeResponse(RadioResponseInfo info) {
  if (info == null) {
    return buildErrorResponse(RadioError.REQUEST_NOT_SUPPORTED);
  }
  // 兼容旧接口返回字段，避免升级后 Framework 层解析异常
  info.serial = remapSerialIfNeeded(info.serial);
  info.error = convertVendorError(info.error);
  return info;
}`,
      },
    ],
  },
  {
    title: 'OPPO Android U ROM 升级通话模块维护',
    subtitle: 'TeleService / Telecom / InCallUI 全链路开发与故障修复',
    period: '2023.09 — 2024.02',
    stack: ['TeleService', 'Telecom', 'InCallUI', 'IMS', 'Android U'],
    situation:
      'OPPO Android U 版本多机型需要完成通话模块升级适配，涉及 TeleService、Telecom、InCallUI 等多个模块，客户需求和故障修复需要与版本节点同步推进。',
    task:
      '负责通话全链路模块开发维护，闭环客户反馈的通话类故障，保障多机型 ROM 升级按期交付并满足客户验收要求。',
    action:
      '围绕通话建立、来电显示、挂断流程、UI 状态同步等链路进行代码分析与问题定位；对 TeleService、Telecom、InCallUI 之间的状态流转进行联调验证，输出修复方案并跟进版本合入。',
    result: '修复通话类故障 30+，项目均按期交付，客户需求满足率 100%，获得客户官方邮件表扬。',
    metrics: [
      { label: '故障修复', value: '30+', delta: '通话类问题' },
      { label: '客户需求满足率', value: '100%', delta: '按期交付' },
      { label: '覆盖模块', value: '3+', delta: 'TeleService / Telecom / InCallUI' },
      { label: '客户认可', value: '正式表扬', delta: '官方邮件' },
    ],
    snippets: [
      {
        lang: 'java',
        caption: '通话状态同步：Telecom 到 InCallUI（去敏示例）',
        code: `// CallStateController.java
void dispatchCallState(Call call, int newState) {
  if (call == null || call.getState() == newState) return;

  call.setState(newState);
  telecomNotifier.onCallStateChanged(call);
  inCallUiBridge.sync(call.getId(), newState);
}`,
      },
    ],
  },
  {
    title: '荣耀旗舰全系列 ROM 升级通信框架交付',
    subtitle: '搜网模块适配 + Phone 稳定性对外接口 + 5G 异网漫游落地',
    period: '2021.03 — 2023.07',
    stack: ['Android R-U', '搜网', 'Phone 稳定性', '5G 异网漫游', 'Framework'],
    situation:
      '荣耀数字系列、V 系列、Magic 旗舰全系列机型需要从 Android R 到 U 持续完成 ROM 升级，通信模块既要支持新版本适配，也要保障线上稳定性。',
    task:
      '作为搜网与 Phone 稳定性对外唯一技术接口人，负责模块需求开发、故障攻关、客户对接与全流程交付，确保通信功能稳定迭代。',
    action:
      '主导 ROM 升级搜网模块适配，完成搜网制式、信号显示重构与国内 5G 异网漫游功能落地；针对开机驻网慢、信号显示异常、Phone 进程崩溃等问题建立专项定位闭环。',
    result: '累计响应客户需求与问题反馈 100+，攻克核心问题 20+，支撑荣耀旗舰机型顺利完成版本升级，通信功能零重大线上故障，并多次获得客户正式书面表扬。',
    metrics: [
      { label: '客户需求 / 反馈', value: '100+', delta: '全流程响应' },
      { label: '核心问题攻克', value: '20+', delta: '搜网 / Phone 稳定性' },
      { label: '覆盖系列', value: '3 大系列', delta: '数字 / V / Magic' },
      { label: '重大线上故障', value: '0', delta: '通信功能稳定' },
    ],
    snippets: [
      {
        lang: 'java',
        caption: '搜网模式适配：制式与信号显示重构（去敏示例）',
        code: `// NetworkModePolicy.java
NetworkMode resolvePreferredMode(DeviceProfile profile, SimInfo sim) {
  if (profile.supportsNrRoaming() && sim.isDomesticRoaming()) {
    return NetworkMode.NR_LTE_WCDMA_GSM;
  }
  return profile.defaultNetworkMode();
}`,
      },
    ],
  },
  {
    title: '诺基亚海外 ROM 升级运营商适配',
    subtitle: 'Carrier Config + 紧急号码 + VoWiFi + 海外入网认证',
    period: '2020.09 — 2021.02',
    stack: ['Carrier Config', 'Emergency Number', 'VoWiFi', '海外运营商', 'ROM 交付'],
    situation:
      '诺基亚手机面向海外市场进行 ROM 迭代升级，需要满足不同区域运营商定制化通信规范，解决海外网络适配问题并按节点进入量产上市。',
    task:
      '跟进海外运营商定制需求落地，完成通信协议相关模块适配验证，保障产品按时通过入网认证。',
    action:
      '负责 Carrier Config 配置、紧急号码规则、VoWiFi 功能、基础通话等模块适配验证；协同测试和运维团队定位海外通信兼容性问题，输出修复方案并跟进验证。',
    result:
      '所有运营商定制需求与通信问题均按项目节点交付，无需求遗漏与线上遗留问题，支撑产品通过海外运营商入网认证并顺利进入量产阶段。',
    metrics: [
      { label: '定制需求', value: '100%', delta: '按节点交付' },
      { label: '线上遗留', value: '0', delta: '无需求遗漏' },
      { label: '认证结果', value: '通过', delta: '海外运营商入网' },
      { label: '覆盖模块', value: '4+', delta: '配置 / 紧急号码 / VoWiFi / 通话' },
    ],
    snippets: [
      {
        lang: 'xml',
        caption: 'Carrier Config：海外运营商定制配置（去敏示例）',
        code: `<carrier_config>
  <boolean name="carrier_volte_available_bool" value="true" />
  <boolean name="carrier_vowifi_available_bool" value="true" />
  <string-array name="emergency_number_prefixes_string_array">
    <item value="112" />
    <item value="911" />
  </string-array>
</carrier_config>`,
      },
    ],
  },
];
