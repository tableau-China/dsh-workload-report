/**
 * 数据层的「未知」占位值（内部归并键，**绝不直接展示**）。
 *
 * 展示层遇到空 label / provider 时，用词典键兜底：
 *   · 未知模型 → `common.unknownModel`
 *   · 未知供应商 → `common.unknownProvider`
 *   · 未知工作区 → `common.unknownWorkspace`
 *
 * 这样数据层（宿主 / 报告 / 客户端共用）保持语言无关，不会把中文写进接口字段。
 */

/** 未知模型桶的归并键（真实 provider/model 不会以 `__` 开头）。 */
export const UNKNOWN_MODEL_KEY = "__unknown_model__";

/** 未知工作区桶的归并键。 */
export const UNKNOWN_WORKSPACE_KEY = "__unknown_workspace__";
