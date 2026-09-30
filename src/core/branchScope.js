// src/core/branchScope.js
// مين بيشوف ويتحكم في كل الفروع (الأدمن بيتقيّد بفروعه)
const ALL_BRANCHES_ROLES = ["owner", "super_admin"];

/**
 * الفروع اللي اليوزر يقدر يشوفها ويتحكم فيها:
 *  - owner / super_admin → null (كل الفروع)
 *  - غير كده → الفروع اللي ليه صلاحية عليها + فرعه الأساسي
 * (req.user جاي من الـ auth middleware وفيه branchAccess من الـ DB)
 */
const getAllowedBranchIds = (user) => {
  if (ALL_BRANCHES_ROLES.includes(user.role)) return null;
  const ids = new Set((user.branchAccess ?? []).map((a) => a.branchId));
  if (user.branch_id) ids.add(user.branch_id);
  return [...ids];
};

module.exports = { ALL_BRANCHES_ROLES, getAllowedBranchIds };
