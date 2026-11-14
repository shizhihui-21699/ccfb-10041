/**
 * Outgoing sample corpus with ground-truth labels.
 *
 * Each sample is an email attachment / exported file that an employee might
 * send out. Labels name the protected segments that a correct system must
 * flag (`leaks`) and the customer records that appear (`pii`). Samples
 * marked `expectNone` are decoys: same topic, same vocabulary, no copied
 * text — they must produce no alerts, and are the main source of
 * false-positive pressure during calibration.
 */

export type Mutation =
  | 'verbatim'
  | 'punctuation'
  | 'reorder'
  | 'paraphrase'
  | 'truncate'
  | 'merge'
  | 'translate-mix'
  | 'reformat';

export interface LeakLabel {
  docId: string;
  segment: number;
  mutation: Mutation;
}

export interface PiiLabel {
  /** customer_id from CUSTOMER sheet rows */
  recordId: string;
  fields: ('name' | 'phone' | 'email' | 'company' | 'account')[];
}

export interface OutgoingBlock {
  text: string;
  kind?: 'heading' | 'paragraph' | 'row' | 'line';
  sheet?: string;
}

export interface OutgoingSample {
  id: string;
  /** Where the file supposedly came from. */
  scenario: string;
  format: 'docx' | 'xlsx' | 'pdf' | 'txt';
  fileName: string;
  sheets?: string[];
  blocks: OutgoingBlock[];
  /** Segments that must be detected. */
  leaks: LeakLabel[];
  /** Customer records that must be detected. */
  pii: PiiLabel[];
  /** Decoy with no leak at all. */
  expectNone: boolean;
  notes?: string;
}

const p = (text: string, kind: OutgoingBlock['kind'] = 'paragraph'): OutgoingBlock => ({ text, kind });
const row = (text: string, sheet: string): OutgoingBlock => ({ text, kind: 'row', sheet });

export const OUTGOING: OutgoingSample[] = [
  {
    id: 'OUT-01',
    scenario: '项目组把备忘录前两段原样贴进周报',
    format: 'docx',
    fileName: '并购项目周报-第38周.docx',
    blocks: [
      p('本周进展如下，供项目组内部参考。', 'heading'),
      p('一、交易结构。本次交易的标的为星源新材料有限公司100%股权，交易对价暂定为人民币4.8亿元，其中现金支付3.1亿元，股份支付1.7亿元。'),
      p('二、估值基准。双方约定以2025年度经审计的扣非净利润为基准，按12.5倍市盈率进行估值调整，若实际净利润低于承诺值的90%，则触发对价下调条款。'),
      p('下周计划：继续推进尽调，准备投决会材料。'),
      p('本周完成反垄断申报材料的初稿整理，等待法务复核后提交。'),
    ],
    leaks: [
      { docId: 'MA-MEMO', segment: 0, mutation: 'verbatim' },
      { docId: 'MA-MEMO', segment: 1, mutation: 'verbatim' },
    ],
    pii: [],
    expectNone: false,
  },
  {
    id: 'OUT-02',
    scenario: '换成英文标点与半角字符后外发',
    format: 'txt',
    fileName: '交易要点.txt',
    blocks: [
      p('交易结构: 本次交易的标的为星源新材料有限公司100%股权, 交易对价暂定为人民币4.8亿元, 其中现金支付3.1亿元, 股份支付1.7亿元。'),
      p('交割条件: 反垄断审查通过, 核心技术人员签署竞业限制协议, 标的公司完成3项历史关联交易的清理, 且不存在未披露的对外担保。'),
    ],
    leaks: [
      { docId: 'MA-MEMO', segment: 0, mutation: 'punctuation' },
      { docId: 'MA-MEMO', segment: 2, mutation: 'punctuation' },
    ],
    pii: [],
    expectNone: false,
  },
  {
    id: 'OUT-03',
    scenario: '把风险段落的句子顺序调换后写进汇报',
    format: 'docx',
    fileName: '风险事项说明.docx',
    blocks: [
      p('主要客户集中度较高，前五大客户合计贡献收入的68.3%；标的公司2024年度营业收入较上年下降7.6%，存在客户流失导致的业绩下滑风险。'),
      p('上述情况已与管理层沟通，要求补充客户访谈记录。'),
    ],
    leaks: [
      { docId: 'MA-MEMO', segment: 4, mutation: 'reorder' },
      { docId: 'DD-LIST', segment: 2, mutation: 'paraphrase' },
    ],
    pii: [],
    expectNone: false,
    notes: '复述风险段落时同时提到了前五大客户 68.3% 的集中度，与尽调清单第 3 问相关。',
  },
  {
    id: 'OUT-04',
    scenario: '改写成自己的话后发给外部顾问',
    format: 'docx',
    fileName: '项目概况-外发版.docx',
    blocks: [
      p('本次交易拟收购星源新材料有限公司全部股权，交易对价暂定4.8亿元人民币，现金支付3.1亿元，股份支付1.7亿元，并以2025年扣非净利润为基准按12.5倍市盈率调整估值。'),
      p('如有疑问请随时联系。'),
    ],
    leaks: [
      { docId: 'MA-MEMO', segment: 0, mutation: 'paraphrase' },
      { docId: 'MA-MEMO', segment: 1, mutation: 'paraphrase' },
    ],
    pii: [],
    expectNone: false,
    notes: '改写后仍保留交易结构、对价与估值基准，属于对两段的改写泄露。',
  },
  {
    id: 'OUT-05',
    scenario: '只截取半段放进 PPT 备注',
    format: 'txt',
    fileName: '会议备注.txt',
    blocks: [
      p('原股东承诺标的公司2026年至2028年扣非净利润分别不低于4200万元、5600万元和7100万元'),
      p('其他事项待议。'),
      p('会议时间另行通知，请各参会人员提前准备材料。'),
    ],
    leaks: [{ docId: 'MA-MEMO', segment: 3, mutation: 'truncate' }],
    pii: [],
    expectNone: false,
  },
  {
    id: 'OUT-06',
    scenario: '客户名单整表导出（含联系方式）',
    format: 'xlsx',
    fileName: '客户联系表.xlsx',
    sheets: ['Sheet1'],
    blocks: [
      row('客户名称 | 联系人 | 手机 | 邮箱', 'Sheet1'),
      row('江海新能源科技有限公司 | 陈国栋 | 13800138001 | chen.gd@jianghai-energy.example', 'Sheet1'),
      row('恒隆精密制造有限公司 | 林婉清 | 13900139002 | lin.wq@henglong-precision.example', 'Sheet1'),
      row('中科储能技术研究院 | 赵启明 | 13700137003 | zhao.qm@cas-energy.example', 'Sheet1'),
      row('蓝海风电设备有限公司 | 周慧敏 | 13600136004 | zhou.hm@bluewind.example', 'Sheet1'),
    ],
    leaks: [],
    pii: [
      { recordId: 'C001', fields: ['name', 'phone', 'email', 'company'] },
      { recordId: 'C002', fields: ['name', 'phone', 'email', 'company'] },
      { recordId: 'C003', fields: ['name', 'phone', 'email', 'company'] },
      { recordId: 'C004', fields: ['name', 'phone', 'email', 'company'] },
    ],
    expectNone: false,
    notes: '客户名单只存在加盐哈希，因此不应出现任何段落指纹命中；告警全部来自精确数据匹配。',
  },
  {
    id: 'OUT-07',
    scenario: '正文里夹带一个客户的手机号和姓名',
    format: 'docx',
    fileName: '回款跟进记录.docx',
    blocks: [
      p('今日与客户对接人陈国栋电话沟通（13800138001），对方确认本月下旬安排付款，金额与合同一致。'),
      p('后续由财务部跟进开票事宜，预计月底前完成。'),
    ],
    leaks: [],
    pii: [{ recordId: 'C001', fields: ['name', 'phone'] }],
    expectNone: false,
  },
  {
    id: 'OUT-08',
    scenario: '改写手机号格式以规避检查（连字符、空格）',
    format: 'txt',
    fileName: '待办.txt',
    blocks: [
      p('联系林婉清：139-0013-9002，确认下周样品寄送地址。'),
      p('联系赵启明：137 0013 7003，索取技术协议盖章版。'),
      p('提醒自己周五前提交报销单。'),
    ],
    leaks: [],
    pii: [
      { recordId: 'C002', fields: ['name', 'phone'] },
      { recordId: 'C003', fields: ['name', 'phone'] },
    ],
    expectNone: false,
  },
  {
    id: 'OUT-09',
    scenario: '客户名单独有一列姓名，未带联系方式（单字段）',
    format: 'xlsx',
    fileName: '拜访计划.xlsx',
    sheets: ['计划'],
    blocks: [
      row('日期 | 拜访对象 | 形式', '计划'),
      row('11月18日 | 周慧敏 | 现场', '计划'),
      row('11月19日 | 吴建平 | 线上', '计划'),
      row('11月20日 | 郑雅琴 | 现场', '计划'),
    ],
    leaks: [],
    pii: [
      { recordId: 'C004', fields: ['name'] },
      { recordId: 'C005', fields: ['name'] },
      { recordId: 'C006', fields: ['name'] },
    ],
    expectNone: false,
  },
  {
    id: 'OUT-10',
    scenario: '把银行账号贴在邮件正文里',
    format: 'txt',
    fileName: '付款通知.txt',
    blocks: [
      p('请将本期货款汇至以下账户：6222021001123004，户名蓝海风电设备有限公司。'),
      p('汇款后请将回单发送至财务邮箱。'),
    ],
    leaks: [],
    pii: [{ recordId: 'C004', fields: ['account', 'company'] }],
    expectNone: false,
  },
  {
    id: 'OUT-11',
    scenario: '把估值模型的两行假设复制到新表格',
    format: 'xlsx',
    fileName: '测算底稿.xlsx',
    sheets: ['底稿'],
    blocks: [
      row('假设项 | 基准值 | 说明', '底稿'),
      row('2025E扣非净利润 | 3820万元 | 基于在手订单与产能利用率测算', '底稿'),
      row('估值市盈率 | 12.5倍 | 参考同行业可比公司近三年交易均值', '底稿'),
      row('我的补充假设 | 4000万元 | 保守估计，待复核', '底稿'),
    ],
    leaks: [
      { docId: 'VAL-MODEL', segment: 0, mutation: 'verbatim' },
      { docId: 'VAL-MODEL', segment: 1, mutation: 'verbatim' },
      { docId: 'VAL-MODEL', segment: 2, mutation: 'verbatim' },
    ],
    pii: [],
    expectNone: false,
  },
  {
    id: 'OUT-12',
    scenario: '薪酬带宽表格被人力发到外部猎头（重排顺序）',
    format: 'xlsx',
    fileName: '职级参考.xlsx',
    sheets: ['参考'],
    blocks: [
      row('职级 | 岗位族 | 薪酬中位（月） | 薪酬上限（月） | 薪酬下限（月）', '参考'),
      row('P3 | 研发 | 24000 | 30000 | 18000', '参考'),
      row('P4 | 研发 | 36000 | 45000 | 28000', '参考'),
      row('P5 | 研发 | 52000 | 65000 | 40000', '参考'),
    ],
    leaks: [
      { docId: 'COMP-BAND', segment: 0, mutation: 'reorder' },
      { docId: 'COMP-BAND', segment: 2, mutation: 'reorder' },
      { docId: 'COMP-BAND', segment: 3, mutation: 'reorder' },
      { docId: 'COMP-BAND', segment: 4, mutation: 'reorder' },
    ],
    pii: [],
    expectNone: false,
  },
  {
    id: 'OUT-13',
    scenario: '技术方案的产能段落改写后发给设备供应商',
    format: 'pdf',
    fileName: '产线需求说明.pdf',
    blocks: [
      p('本项目建设两条生产线，每条设计能力2.5万吨，合计年产5万吨磷酸铁锂正极材料。年有效运行天数按330天、每天24小时考虑，设备综合利用率目标92%。'),
      p('请供应商据此提供设备清单与初步报价。'),
    ],
    leaks: [{ docId: 'TECH-SPEC', segment: 1, mutation: 'paraphrase' }],
    pii: [],
    expectNone: false,
  },
  {
    id: 'OUT-14',
    scenario: '渗透测试报告结论整段复制进风险通报',
    format: 'docx',
    fileName: '安全风险通报-内部.docx',
    blocks: [
      p('一、高危漏洞。在订单查询接口发现一处SQL注入，攻击者可读取用户表全部字段；该接口未做参数化处理，风险等级评定为高危。'),
      p('二、权限问题。运维堡垒机存在弱口令账户三个，其中两个账户仍在使用出厂默认密码，攻击者可借此横向移动到核心数据库服务器。'),
      p('请各系统负责人于两周内完成整改并反馈。'),
    ],
    leaks: [
      { docId: 'PENTEST', segment: 1, mutation: 'verbatim' },
      { docId: 'PENTEST', segment: 2, mutation: 'verbatim' },
    ],
    pii: [],
    expectNone: false,
  },
  {
    id: 'OUT-15',
    scenario: '把专利交底书的实施例改成表格外发',
    format: 'xlsx',
    fileName: '实验数据.xlsx',
    sheets: ['数据'],
    blocks: [
      row('样品 | 包覆厚度 | 循环保持率 | 热失控起始温度', '数据'),
      row('实施例1 | 3纳米 | 90.1% | 提升12摄氏度', '数据'),
      row('实施例2 | 5纳米 | 92.4% | 提升18摄氏度', '数据'),
      row('实施例3 | 8纳米 | 91.6% | 提升16摄氏度', '数据'),
      row('测试条件 | 45摄氏度 | 1C循环500次 | 较未改性提升11.6个百分点', '数据'),
    ],
    leaks: [{ docId: 'PATENT', segment: 5, mutation: 'reformat' }],
    pii: [],
    expectNone: false,
    notes: '效果数据段落被拆成表格：保留 92.4%、18摄氏度、500次、11.6个百分点等关键值。',
  },
  {
    id: 'OUT-16',
    scenario: '投标报价书的核心报价段落被抄进另一份标书',
    format: 'docx',
    fileName: '竞争项目报价.docx',
    blocks: [
      p('一、投标总价。本项目投标总价为人民币3860万元，其中储能设备3280万元、安装调试420万元、五年运维服务160万元。'),
      p('二、设备清单。提供215千瓦时液冷储能柜40台，配置组串式储能变流器20台、能量管理系统1套、消防系统1套及配套电缆与桥架。'),
      p('三、交付计划。合同生效后45日内完成首批10台交付，90日内完成全部设备到场，120日内完成安装调试并进入试运行。'),
    ],
    leaks: [
      { docId: 'TENDER', segment: 0, mutation: 'verbatim' },
      { docId: 'TENDER', segment: 1, mutation: 'verbatim' },
      { docId: 'TENDER', segment: 3, mutation: 'verbatim' },
    ],
    pii: [],
    expectNone: false,
  },
  {
    id: 'OUT-17',
    scenario: '尽调清单被改成 Word 清单后外发（表格转段落）',
    format: 'docx',
    fileName: '待补充材料清单.docx',
    blocks: [
      p('1. 财务：请提供最近三年经审计的财务报表及附注，包括合并范围变动说明。责任方：标的公司财务部，优先级高。'),
      p('2. 财务：请说明2024年度营业收入下降7.6%的具体原因及主要客户流失情况。责任方：标的公司财务部，优先级高。'),
      p('3. 法务：请提供全部诉讼、仲裁案件的清单及进展，包括已结案事项的判决履行情况。责任方：标的公司法务部，优先级高。'),
    ],
    leaks: [
      { docId: 'DD-LIST', segment: 1, mutation: 'reformat' },
      { docId: 'DD-LIST', segment: 2, mutation: 'reformat' },
      { docId: 'DD-LIST', segment: 5, mutation: 'reformat' },
    ],
    pii: [],
    expectNone: false,
  },
  {
    id: 'OUT-18',
    scenario: '董事会决议摘要被泄露到外部群（改写版）',
    format: 'txt',
    fileName: '消息记录.txt',
    blocks: [
      p('听说董事会已经通过了收购星源新材料的议案，对价不超过4.8亿元，还授权管理层去签协议。'),
      p('另外还要发股份募集配套资金1.7亿元，用来支付部分对价。'),
      p('股东大会定在11月6日。'),
    ],
    leaks: [
      { docId: 'BOARD', segment: 1, mutation: 'paraphrase' },
      { docId: 'BOARD', segment: 2, mutation: 'paraphrase' },
    ],
    pii: [],
    expectNone: false,
  },
  {
    id: 'OUT-19',
    scenario: 'QBR 收入构成整表外发（表格转 PDF）',
    format: 'pdf',
    fileName: '收入情况.pdf',
    blocks: [
      p('业务板块 | 收入（万元） | 占比 | 毛利率 | 备注'),
      p('储能设备 | 21400 | 55.4% | 26.8% | 华东区域项目集中交付'),
      p('正极材料 | 12600 | 32.6% | 18.2% | 受碳酸锂价格下行影响'),
      p('运维服务 | 4600 | 11.9% | 38.5% | 存量项目续约率91%'),
    ],
    leaks: [
      { docId: 'QBR', segment: 8, mutation: 'reformat' },
      { docId: 'QBR', segment: 9, mutation: 'reformat' },
      { docId: 'QBR', segment: 10, mutation: 'reformat' },
      { docId: 'QBR', segment: 11, mutation: 'reformat' },
    ],
    pii: [],
    expectNone: false,
  },
  {
    id: 'OUT-20',
    scenario: '渠道政策的两条被拆出来发给经销商（微调措辞）',
    format: 'docx',
    fileName: '经销商须知.docx',
    blocks: [
      p('金牌经销商享受建议零售价68折优惠，银牌经销商享受72折，认证级经销商享受76折，所有折扣仅适用于授权区域与授权产品线。'),
      p('金牌经销商在授权区域内享有排他保护，公司不会直接向该区域内的终端客户报价，跨区销售必须提前报备并取得书面同意。'),
    ],
    leaks: [
      { docId: 'CHANNEL', segment: 1, mutation: 'paraphrase' },
      { docId: 'CHANNEL', segment: 3, mutation: 'paraphrase' },
    ],
    pii: [],
    expectNone: false,
  },
  {
    id: 'OUT-21',
    scenario: '员工手册整段复制进外部咨询问卷',
    format: 'txt',
    fileName: '问卷回答.txt',
    blocks: [
      p('第四条 请假制度。年休假按工龄计算，满一年不满十年者五天，满十年不满二十年者十天，满二十年者十五天，原则上应在当年使用完毕。'),
      p('第六条 保密义务。员工在职期间及离职后均应保守公司商业秘密，不得向任何第三方披露客户信息、技术资料与经营数据。'),
    ],
    leaks: [
      { docId: 'HANDBOOK', segment: 3, mutation: 'verbatim' },
      { docId: 'HANDBOOK', segment: 5, mutation: 'verbatim' },
    ],
    pii: [],
    expectNone: false,
  },
  {
    id: 'OUT-22',
    scenario: '法务风险清单被改成汇报口径（改写较重）',
    format: 'docx',
    fileName: '法务风险汇报.docx',
    blocks: [
      p('知识产权方面，核心产品所使用的正极配方有可能落入某高校专利的权利要求范围，我们计划在量产之前完成自由实施分析，并准备设计绕开方案。'),
      p('劳动用工方面，一些研发人员实行大小周，休息日加班工资没有依法支付，存在被集体主张补发加班费与经济补偿的风险。'),
    ],
    leaks: [
      { docId: 'LEGAL-RISK', segment: 1, mutation: 'paraphrase' },
      { docId: 'LEGAL-RISK', segment: 2, mutation: 'paraphrase' },
    ],
    pii: [],
    expectNone: false,
  },
  {
    id: 'OUT-23',
    scenario: '供应商报价表部分行被复制到比价邮件',
    format: 'xlsx',
    fileName: '比价.xlsx',
    sheets: ['比价'],
    blocks: [
      row('供应商 | 物料类别 | 报价（元/吨） | 账期', '比价'),
      row('东海化工材料厂 | 正极前驱体 | 78000 | 60天', '比价'),
      row('瑞泽新材料有限公司 | 正极前驱体 | 81500 | 45天', '比价'),
      row('华信精细化工 | 正极前驱体 | 74200 | 90天', '比价'),
    ],
    leaks: [
      { docId: 'VENDOR', segment: 0, mutation: 'truncate' },
      { docId: 'VENDOR', segment: 1, mutation: 'truncate' },
      { docId: 'VENDOR', segment: 2, mutation: 'truncate' },
      { docId: 'VENDOR', segment: 3, mutation: 'truncate' },
    ],
    pii: [],
    expectNone: false,
  },
  {
    id: 'OUT-24',
    scenario: '产品路线图的两段被翻译成英文后外发（中英混排）',
    format: 'docx',
    fileName: 'product-roadmap.docx',
    blocks: [
      p('Product plan: 面向工商业储能场景推出模块化液冷储能柜，single cabinet capacity 215 kWh，支持四机并联扩展至860千瓦时。'),
      p('In 2026: 发布314千瓦时大容量版本，系统循环效率提升至89%，单瓦时成本下降12%。'),
      p('Target markets: 华东、华南、欧洲。'),
    ],
    leaks: [
      { docId: 'ROADMAP', segment: 0, mutation: 'translate-mix' },
      { docId: 'ROADMAP', segment: 2, mutation: 'translate-mix' },
    ],
    pii: [],
    expectNone: false,
  },
  {
    id: 'OUT-25',
    scenario: '股权转让协议的违约条款与生效条款被复制',
    format: 'txt',
    fileName: '条款摘录.txt',
    blocks: [
      p('第六条 违约责任。任何一方违反本协议约定，应向守约方支付违约金人民币500万元；违约金不足以弥补损失的，还应赔偿实际损失。'),
      p('第八条 生效条件。本协议自双方授权代表签字并加盖公章之日起生效，有效期为三年，一式陆份，双方各执叁份，具有同等法律效力。'),
    ],
    leaks: [
      { docId: 'SPA', segment: 5, mutation: 'verbatim' },
      { docId: 'SPA', segment: 7, mutation: 'verbatim' },
    ],
    pii: [],
    expectNone: false,
  },
  {
    id: 'OUT-26',
    scenario: '保密协议的保密期限条款被引用（标点改动）',
    format: 'docx',
    fileName: '答复函.docx',
    blocks: [
      p('关于保密期限，按双方协议第五条：本协议保密义务自披露之日起生效，至披露后第五个周年日终止；涉及技术秘密的，保密义务持续至该技术秘密公开为止。'),
      p('以上答复，请查收。'),
    ],
    leaks: [{ docId: 'NDA', segment: 4, mutation: 'punctuation' }],
    pii: [],
    expectNone: false,
  },
  {
    id: 'OUT-27',
    scenario: '把客户名单与交易结构放在同一封邮件里',
    format: 'docx',
    fileName: '尽调资料打包说明.docx',
    blocks: [
      p('一、交易结构。本次交易的标的为星源新材料有限公司100%股权，交易对价暂定为人民币4.8亿元，其中现金支付3.1亿元，股份支付1.7亿元。'),
      p('二、客户访谈安排：江海新能源科技有限公司 陈国栋 13800138001；恒隆精密制造有限公司 林婉清 13900139002。'),
      p('三、其他资料随后发送。'),
    ],
    leaks: [{ docId: 'MA-MEMO', segment: 0, mutation: 'verbatim' }],
    pii: [
      { recordId: 'C001', fields: ['name', 'phone', 'company'] },
      { recordId: 'C002', fields: ['name', 'phone', 'company'] },
    ],
    expectNone: false,
    notes: '表格数据被改写成叙述句，客户记录仍应通过加盐哈希命中；同时命中备忘录的段落指纹。',
  },
  {
    id: 'OUT-28',
    scenario: '同一客户姓名+邮箱，但公司名称换了写法（规范化测试）',
    format: 'txt',
    fileName: '通讯录.txt',
    blocks: [
      p('罗志强　luo.zq@xinghui-med.example　星辉医疗器械'),
      p('唐敏　tang.m@yungang-data.example　云港数据'),
      p('以上为新增联系人，请同步至 CRM。'),
    ],
    leaks: [],
    pii: [
      { recordId: 'C010', fields: ['name', 'email'] },
      { recordId: 'C011', fields: ['name', 'email'] },
    ],
    expectNone: false,
  },
  {
    id: 'OUT-29',
    scenario: '正式对外公告：只披露已公开的交易事实（同主题，非泄露）',
    format: 'pdf',
    fileName: '收购公告.pdf',
    blocks: [
      p('本公司于近日召开董事会，审议通过了关于收购星源新材料有限公司股权的议案。本次交易的具体方案、交易价格及支付安排将按照相关规则履行信息披露义务。'),
      p('本次交易尚需提交股东大会审议，并取得有关监管部门的批准，能否获得批准以及最终获得批准的时间均存在不确定性，敬请投资者注意投资风险。'),
    ],
    leaks: [],
    pii: [],
    expectNone: true,
    notes: '公告口径，与备忘录主题相同但没有任何原句。',
  },
  {
    id: 'OUT-30',
    scenario: '行业研究摘录：同样讨论估值与市盈率（同主题诱饵）',
    format: 'docx',
    fileName: '行业观察.docx',
    blocks: [
      p('关于股权收购的估值方法，通常采用市盈率法，以经审计的扣非净利润为基准，并结合标的公司未来三年的业绩承诺进行调整。'),
      p('从行业看，锂电正极材料的产能扩张与估值水平值得关注，行业整体市盈率维持在12倍左右，龙头企业的估值溢价较为明显。'),
      p('以上为研究观点，不构成投资建议。'),
    ],
    leaks: [],
    pii: [],
    expectNone: true,
    notes: '与 MA-MEMO、TECH-SPEC 主题词汇高度重合但无原句。',
  },
  {
    id: 'OUT-31',
    scenario: '新员工入职须知（同样用规章制度词汇，非泄露）',
    format: 'txt',
    fileName: '入职须知.txt',
    blocks: [
      p('欢迎加入！请于入职当日携带身份证、学历证明与离职证明原件，到人力资源部办理入职手续。'),
      p('公司每周上班五天，每天工作八小时；上下班需在企业微信签到，如需请假请先与直属主管确认并提交申请。'),
      p('如有疑问请联系人力资源部同事，祝工作顺利。'),
    ],
    leaks: [],
    pii: [],
    expectNone: true,
    notes: '与员工手册主题一致（考勤、入职、请假），但没有任何原句。',
  },
  {
    id: 'OUT-32',
    scenario: '客户拜访总结：提到客户但只有公开信息（非泄露）',
    format: 'docx',
    fileName: '拜访总结.docx',
    blocks: [
      p('本周拜访了客户位于江苏的生产基地，双方就行业趋势与产品规划进行了交流。'),
      p('对方对储能系统集成表现出兴趣，后续可安排技术交流。本次未涉及商务条款。'),
    ],
    leaks: [],
    pii: [],
    expectNone: true,
    notes: '只出现公司名（单字段且已公开），不应触发组合告警，也不应命中名单中的任何记录组合。',
  },
  {
    id: 'OUT-33',
    scenario: '供应商开发的普通询价（与报价表主题相近）',
    format: 'xlsx',
    fileName: '询价单.xlsx',
    sheets: ['询价'],
    blocks: [
      row('物料类别 | 规格 | 需求数量 | 期望交期', '询价'),
      row('正极前驱体 | 粒径D50 8微米 | 120吨 | 30天', '询价'),
      row('铝塑膜 | 厚度113微米 | 8000平米 | 45天', '询价'),
      row('碳酸锂 | 电池级99.5% | 60吨 | 20天', '询价'),
    ],
    leaks: [],
    pii: [],
    expectNone: true,
    notes: '物料类别与供应商表重叠，但没有报价、账期等原始数据行。',
  },
  {
    id: 'OUT-34',
    scenario: '把客户名字与无关内容混写（应仅报单字段或组合）',
    format: 'docx',
    fileName: '年会名单.docx',
    blocks: [
      p('年会抽奖名单：陈国栋、林婉清、赵启明、周慧敏、吴建平。'),
      p('请以上同事于周五下午到行政处领取奖品。'),
      p('另附年会流程与座位安排。'),
    ],
    leaks: [],
    pii: [
      { recordId: 'C001', fields: ['name'] },
      { recordId: 'C002', fields: ['name'] },
      { recordId: 'C003', fields: ['name'] },
      { recordId: 'C004', fields: ['name'] },
      { recordId: 'C005', fields: ['name'] },
    ],
    expectNone: false,
    notes: '只有姓名一个字段，属于低风险命中，应可被阈值筛掉或标记为误报。',
  },
  {
    id: 'OUT-35',
    scenario: '跨两段拼接复制（中间插入一句自己的话）',
    format: 'docx',
    fileName: '摘录两段.docx',
    blocks: [
      p('四、业绩承诺。原股东承诺标的公司2026年至2028年扣非净利润分别不低于4200万元、5600万元和7100万元，三年累计未达标部分以现金方式补偿。'),
      p('（以下为我的理解，供参考）'),
      p('六、人员安排。交易完成后标的公司现有管理层原则上留任十二个月，核心技术团队需签署不低于三年的服务期协议，离职后两年内不得从事同类业务。'),
    ],
    leaks: [
      { docId: 'MA-MEMO', segment: 3, mutation: 'verbatim' },
      { docId: 'MA-MEMO', segment: 5, mutation: 'verbatim' },
    ],
    pii: [],
    expectNone: false,
  },
  {
    id: 'OUT-36',
    scenario: '仅泄露技术方案中的一句关键参数',
    format: 'txt',
    fileName: '参数备忘.txt',
    blocks: [
      p('产品压实密度目标为2.45克每立方厘米，首次放电比容量不低于158毫安时每克。'),
      p('以上参数仅供内部讨论。'),
    ],
    leaks: [{ docId: 'TECH-SPEC', segment: 3, mutation: 'truncate' }],
    pii: [],
    expectNone: false,
  },
];
