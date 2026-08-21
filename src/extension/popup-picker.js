// 只验证不落库的目标选择器。与设置页共用 target-picker 导航逻辑，但确认时只经 Bridge 验证
// 并返回目标，绝不直接写 chrome.storage——弹窗（仅本次目标）与设置页预设表单（#35，目标随
// 预设整体经 SAVE_PRESETS 写回）都复用它，持久化由各调用方自己负责。
import { createTargetPicker } from './target-picker.js';

export function createPopupPicker({ listSpaces, listNodes, validateDestination, initialDestination = null }) {
  return createTargetPicker({
    listSpaces,
    listNodes,
    initialDestination,
    saveDestination: async (destination) => {
      // 只验证，不持久化；路径合并由 target-picker 的 saveManual 统一完成
      return validateDestination(destination);
    },
  });
}
