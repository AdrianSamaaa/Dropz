const { contextBridge, ipcRenderer, webUtils } = require('electron');

const on = channel => fn => {
  const handler = (_e, ...args) => fn(...args);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('drops', {
  // drop widget
  init: () => ipcRenderer.invoke('drop:init'),
  setHeight: h => ipcRenderer.invoke('drop:setHeight', h),
  moveStart: (ox, oy) => ipcRenderer.send('drop:moveStart', { ox, oy }),
  moveEnd: () => ipcRenderer.send('drop:moveEnd'),
  rename: name => ipcRenderer.invoke('drop:rename', name),
  addFiles: (files, index) => ipcRenderer.invoke('drop:addPaths', {
    paths: files.map(f => webUtils.getPathForFile(f)).filter(Boolean),
    index,
  }),
  launch: id => ipcRenderer.invoke('drop:launch', id),
  reorder: ids => ipcRenderer.invoke('drop:reorder', ids),
  moveItem: (fromDropId, itemId, index) => ipcRenderer.invoke('drop:moveItem', { fromDropId, itemId, index }),
  renameItem: (itemId, name) => ipcRenderer.invoke('drop:renameItem', { itemId, name }),
  menu: () => ipcRenderer.invoke('drop:menu'),
  itemMenu: id => ipcRenderer.invoke('drop:itemMenu', id),
  togglePin: () => ipcRenderer.invoke('drop:togglePin'),
  openPicker: () => ipcRenderer.invoke('drop:openPicker'),
  onUpdate: on('drop:update'),
  onSpace: on('drop:space'),
  onBeginRename: on('drop:beginRename'),
  onItemRename: on('item:beginRename'),
  onSetExpanded: on('drop:setExpanded'),
  onToast: on('drop:toast'),

  // "Add apps" picker
  picker: {
    init: () => ipcRenderer.invoke('picker:init'),
    scan: () => ipcRenderer.invoke('picker:scan'),
    icon: p => ipcRenderer.invoke('picker:icon', p),
    add: (paths, tidy) => ipcRenderer.invoke('picker:add', { paths, tidy }),
    browse: () => ipcRenderer.invoke('picker:browse'),
    close: () => ipcRenderer.send('picker:close'),
    onTarget: on('picker:target'),
  },
});
