// Drive 目录选择器（#66）：树形 picker 内核（tree-picker.js）的第二个适配器。
// 根层 = 「我的空间」根目录的子项列表；下钻 = 子文件夹。bridge 端返回全部子项：
// 文件夹整行可选中也可下钻，文件项（type !== 'folder'）置灰展示——不可选中不可下钻。
// 与 wiki 适配器（target-picker.js）同构：不依赖 DOM 或 chrome API，可在 node:test 下直接测试。
//
// crumb 形状：{ folderToken, title }；destination 模板：{ folderToken, title, path? }，
// folderToken 为 null 即云盘根目录（合法态，语义见 #62 决议）。
import { createTreePicker } from './tree-picker.js';

// 根层合成行：让「存到云盘根目录」在 picker 里显式可选。不可下钻（下钻根层 = 根列表本身）
export const DRIVE_ROOT_ITEM = Object.freeze({ folderToken: null, name: '我的空间', driveRoot: true });

// 文件夹行（type === 'folder'）之外的子项都是文件项：置灰展示，不可选中不可下钻
function isFolderItem(item) {
  return !item?.driveRoot && item?.type === 'folder' && Boolean(item?.folderToken);
}

export function createDriveAdapter({ listFolders, save }) {
  return {
    async listRoot({ cursor, limit }) {
      const result = await listFolders({ folderToken: undefined, cursor, limit });
      // 合成根目录行只在第一页 prepend；后续分页页直接续接子项
      const items = cursor ? result.items : [DRIVE_ROOT_ITEM, ...result.items];
      return { items, hasMore: result.hasMore, nextPageToken: result.nextPageToken };
    },

    async listChildren({ crumbs, cursor, limit }) {
      const result = await listFolders({ folderToken: crumbs[crumbs.length - 1].folderToken, cursor, limit });
      return { items: result.items, hasMore: result.hasMore, nextPageToken: result.nextPageToken };
    },

    // 根目录行与文件夹都可选中；根目录行自带 path（[我的空间]），文件夹缺省 path，
    // 由内核用 crumbs 的标题链路补上。文件项不可选中
    isSelectable(item) {
      if (item?.driveRoot) return { folderToken: null, title: item.name, path: [item.name] };
      if (!isFolderItem(item)) return false;
      return { folderToken: item.folderToken, title: item.name };
    },

    // 只有文件夹可下钻；根目录行与文件项都不可下钻
    crumbOf(item) {
      if (!isFolderItem(item)) return false;
      return { folderToken: item.folderToken, title: item.name };
    },

    save,
  };
}

// validateFolder({ folderToken }) → { folderToken, name }：只验证不持久化（同 popup-picker 的
// 语义），folderToken 为 null 即根目录应合法通过。确认后返回 { folderToken, title, path }，
// 写预设（options）还是仅本次（popup）由调用方决定。
export function createDrivePicker({ listFolders, validateFolder, initialDestination = null }) {
  return createTreePicker({
    adapter: createDriveAdapter({
      listFolders,
      save: async (destination) => {
        const folder = await validateFolder({ folderToken: destination.folderToken ?? null });
        return { destination: { folderToken: folder.folderToken ?? null, title: folder.name } };
      },
    }),
    initialDestination,
  });
}
