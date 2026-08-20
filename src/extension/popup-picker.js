// 弹窗「仅本次更改」选择器。与设置页共用 target-picker 导航逻辑，但确认时只经 Bridge 验证
// 并返回目标，绝不写 chrome.storage——持久化的默认目标因此天然不受临时选择影响。
import { createTargetPicker } from './target-picker.js';

export function createPopupPicker({ listSpaces, listNodes, validateDestination }) {
  return createTargetPicker({
    listSpaces,
    listNodes,
    saveDestination: async (destination) => {
      // 只验证，不持久化；路径合并由 target-picker 的 saveManual 统一完成
      return validateDestination(destination);
    },
  });
}
