'use strict';
/**
 * 应用窗口：一个正在运行的安卓应用 = 一个干净的 Windows 窗口。
 *
 * 窗口里只有顶部一条 38px 的标题栏（旋转 / 最小化 / 最大化 / 关闭），
 * 下面的整块画面是嵌进来的模拟器窗口（SetParent），所以看不到安卓桌面、
 * 看不到模拟器自带的侧边工具栏，也不会多出第二个任务栏图标。
 */
const { BrowserWindow, screen, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const { hookOptions } = require('./pointer');

const TITLEBAR_H = 38;
/**
 * 模拟器窗口四周自带 8px 的灰色内边距（Qt 的边框留白），
 * 而真正的 LCD 画面是从 +8px 开始的。把子窗口整体放大 16px 并向左上偏移 8px，
 * 这圈灰边就正好被推到客户区外面，画面干净地贴满四周。
 */
const EMU_PAD = 8;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function iconUrl(p) {
  if (!p || !fs.existsSync(p)) return '';
  return `file:///${p.replace(/\\/g, '/').replace(/ /g, '%20')}?v=${fs.statSync(p).mtimeMs}`;
}

class AppWindow {
  constructor({ agent, setOrientation, mouseHook = false, pointerConfig = null }) {
    this.agent = agent;
    this.setOrientation = setOrientation || null;
    // 全局鼠标钩子只在「应用窗口前台 + 至少一项映射开启」时安装。
    // pointerConfig 传函数：设置页改了开关，下一次 focus 就生效，不用重启。
    this.mouseHook = mouseHook;
    this.pointerConfig = pointerConfig;
    this.win = null;
    this.embedded = false;
    this.closing = null;
    this.pkg = null;
    this.state = { label: '', tip: '', ready: false, landscape: false };
    this._fitTimer = null;
    this._closedCb = null;
  }

  get isOpen() { return !!(this.win && !this.win.isDestroyed()); }

  /** 竖屏 / 横屏下窗口内容的目标尺寸（自动缩放到屏幕内） */
  static sizeFor(area, portrait, landscape) {
    const p = portrait || { w: 540, h: 960 };
    const availH = Math.max(360, (area.h || 1040) - TITLEBAR_H - 48);
    const availW = Math.max(300, (area.w || 1920) - 80);
    if (landscape) {
      const k = Math.min(availW / p.h, availH / p.w);
      return { w: Math.round(p.h * k), h: Math.round(p.w * k) };
    }
    const k = Math.min(availH / p.h, availW / p.w);
    return { w: Math.round(p.w * k), h: Math.round(p.h * k) };
  }

  _area() {
    const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const a = d.workArea || d.bounds;
    return { x: a.x, y: a.y, w: a.width, h: a.height };
  }

  _scale() {
    try {
      const b = this.win ? this.win.getBounds() : this._area();
      return screen.getDisplayMatching(b).scaleFactor || 1;
    } catch (_) {
      return 1;
    }
  }

  /**
   * 打开（或复用）应用窗口。
   * @param {object} o 应用包名、名称、图标、尺寸预设、显示方向及关闭回调。
   * @param {boolean} [o.landscape] 是否以横屏尺寸打开窗口。
   * @returns {BrowserWindow} 宿主窗口。
   */
  open(o) {
    const { pkg, label, iconPath, portrait, fullscreen, landscape = false } = o;
    this._closedCb = o.onClosed || null;
    this.pkg = pkg;
    this.portrait = portrait || { w: 540, h: 960 };
    this.state = { label: label || '应用', tip: '正在启动安卓运行时…', ready: false, landscape };

    const area = this._area();
    const size = AppWindow.sizeFor(area, this.portrait, landscape);
    const w = Math.max(320, size.w);
    const h = Math.max(420, size.h + TITLEBAR_H);

    const iconFile = iconPath && fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : undefined;
    if (this.isOpen) {
        this.win.setTitle(this.state.label);
        if (iconFile) this.win.setIcon(iconFile);
        if (!this.win.isMaximized()) {
            this.win.setBounds({
                x: Math.round(area.x + (area.w - w) / 2),
                y: Math.round(area.y + (area.h - h) / 2),
                width: w,
                height: h,
            });
        }
        this.win.hide();
        this._push();
        return this.win;
    }

    this.win = new BrowserWindow({
      width: w,
      height: h,
      minWidth: 320,
      minHeight: 420,
      x: Math.round(area.x + (area.w - w) / 2),
      y: Math.round(area.y + (area.h - h) / 2),
      show: false,
      frame: false,
      thickFrame: true,
      resizable: true,
      maximizable: true,
      backgroundColor: '#0b0c0e',
      title: label || 'ApkStart',
      icon: iconFile,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        spellcheck: false,
        backgroundThrottling: false,
      },
    });

    this.win.loadFile(path.join(__dirname, '..', 'ui', 'shell.html'));
    // 页面标题会把窗口标题改成 shell.html 的 <title>，任务栏就认不出是哪个应用了，
    // 这里挡住，让 OS 标题一直等于应用名（任务栏悬浮提示、Alt+Tab 都靠它）。
    this.win.webContents.on('page-title-updated', (e) => {
      e.preventDefault();
      try { this.win.setTitle(this.state.label); } catch (_) { /* 窗口可能已销毁 */ }
    });
    this.win.once('ready-to-show', () => {
      this._push();
    });

    const refit = () => this.scheduleFit();
    this.win.on('resize', refit);
    this.win.on('move', refit);
    this.win.on('maximize', refit);
    this.win.on('unmaximize', refit);
    this.win.on('restore', () => {
      this.agent.show().catch(() => {});
      this.scheduleFit();
    });
    this.win.on('minimize', () => { this.agent.hide().catch(() => {}); });
    this.win.on('close', (event) => {
        event.preventDefault();
        this.close().catch(() => {});
    });
    this.win.on('closed', () => {
      this.win = null;
      this.embedded = false;
      const pkg = this.pkg;
      this.pkg = null;
      if (this._closedCb) this._closedCb(pkg);
    });
    // 只在「应用窗口真正处于前台」且至少一项鼠标映射开启时装全局钩子；
    // 失焦/关闭立即卸载，绝不让 ApkStart 在后台拖慢整个系统的鼠标。
    this.win.on('focus', () => this._syncHook(true));
    this.win.on('blur', () => this._syncHook(false));

    if (fullscreen) this.win.maximize();
    return this.win;
  }

  _pointerOptions() {
    const getter = this.pointerConfig || this.mouseHook;
    const raw = typeof getter === 'function' ? getter() : getter;
    return hookOptions(raw);
  }

  _syncHook(active) {
    const opts = this._pointerOptions();
    const on = !!active && opts.enabled;
    if (this.agent && typeof this.agent.setHook === 'function') {
      this.agent.setHook(on, opts).catch(() => {});
    }
  }

  /** 设置页改了鼠标映射：按当前焦点重新同步一次（不重装钩子线程） */
  refreshPointer() {
    const focused = this.isOpen && !!this.win.isFocused();
    if (!focused) {
      // 窗口没在前台：只卸载，别让钩子在后台空转
      if (this.agent && typeof this.agent.setHook === 'function') {
        this.agent.setHook(false).catch(() => {});
      }
      return;
    }
    this._syncHook(true);
  }

  setState(patch) {
    this.state = { ...this.state, ...patch };
    this._push();
  }

  _push() {
    if (!this.isOpen) return;
    try {
      this.win.webContents.send('shell:state', {
        ...this.state,
        iconUrl: this.iconUrl || '',
      });
    } catch (_) { /* 窗口可能刚关闭 */ }
  }

  setIcon(p) { this.iconUrl = iconUrl(p); this._push(); }

  /**
   * 嵌入指定运行时的显示窗口，失败时交给启动流程显示具体原因。
   * @param {{port?: number, pid?: number}|null} target 运行时的窗口标识。
   * @throws {Error} 宿主窗口已关闭、找不到显示窗口或窗口代理嵌入失败。
   */
  async embed(target) {
    if (!this.isOpen) throw new Error('应用窗口已关闭，请重新打开应用');
    const hwnd = this._hwnd();
    if (!hwnd) throw new Error('无法取得 ApkStart 应用窗口的句柄');
    if (!target) throw new Error('当前安卓运行时没有可嵌入的窗口');
    const result = await this.agent.embed(hwnd, this._rect(), target);
    if (result.ok) {
        this.embedded = true;
        return;
    }
    if (result.error === 'no-window') throw new Error('未找到可嵌入的安卓模拟器窗口');
    if (result.error === 'set-parent-failed') {
        throw new Error(`Windows 未能将模拟器窗口嵌入 ApkStart（错误代码 ${result.win32}）`);
    }
    throw new Error('窗口代理未能嵌入安卓模拟器窗口');
  }

  /** 在应用画面就绪后，将模拟器窗口贴合宿主客户区。 */
  async fitNow() {
    if (!this.isOpen || !this.state.ready) return;
    await this.agent.fit(this._rect()).catch(() => {});
  }

  /**
   * 计算模拟器子窗口的物理像素矩形，给标题栏和控制按钮留出完整空间。
   * @returns {{x: number, y: number, w: number, h: number}} 宿主客户区内的画面矩形。
   */
  _rect() {
    const sf = this._scale();
    const b = this.win.getContentBounds();
    return {
      x: -EMU_PAD,
      y: Math.round(TITLEBAR_H * sf),
      w: Math.round(b.width * sf) + EMU_PAD * 2,
      h: Math.round((b.height - TITLEBAR_H) * sf) + EMU_PAD,
    };
  }

  scheduleFit() {
    if (!this.isOpen) return;
    if (this._fitTimer) return;
    this._fitTimer = setTimeout(() => {
      this._fitTimer = null;
      this.fitNow();
    }, 40);
  }

  _hwnd() {
    try {
      const buf = this.win.getNativeWindowHandle();
      const v = buf.length >= 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0));
      return v.toString();
    } catch (_) {
      return null;
    }
  }

  /**
   * 横竖屏切换。
   * 先转动模拟器画面，再按目标方向调整宿主窗口尺寸。
   * @returns {Promise<boolean>} 切换后的窗口是否为横屏。
   */
  async rotate() {
    if (!this.isOpen) return this.state.landscape;
    const next = !this.state.landscape;
    if (this.setOrientation && !(await this.setOrientation(next))) return this.state.landscape;
    const area = this._area();
    const size = AppWindow.sizeFor(area, this.portrait, next);
    if (!this.win.isMaximized()) {
      this.win.setContentSize(Math.max(320, size.w), Math.max(420, size.h + TITLEBAR_H));
      const b = this.win.getBounds();
      this.win.setPosition(
        Math.round(area.x + (area.w - b.width) / 2),
        Math.round(area.y + (area.h - b.height) / 2),
      );
    }
    this.state.landscape = next;
    this._push();
    await sleep(250);
    await this.fitNow();
    // 模拟器换比例后还会自己再调一次窗口，收尾再贴合一次免得留黑边
    await sleep(600);
    await this.fitNow();
    return next;
  }

  toggleMaximize() {
    if (!this.isOpen) return;
    if (this.win.isMaximized()) this.win.unmaximize();
    else this.win.maximize();
    this.scheduleFit();
  }

  minimize() { if (this.isOpen) this.win.minimize(); }

  /**
   * 隐藏并移出模拟器画面后关闭宿主窗口，保留运行时供下次启动复用。
   * @param {object} options 关闭选项。
   * @param {boolean} [options.keepApp] 是否保留 Android 应用进程。
   * @returns {Promise<void>} 窗口及应用清理完成后返回。
   */
  async close({ keepApp = false } = {}) {
    if (this.closing) return this.closing;
    if (!this.isOpen) return;
    const win = this.win;
    const pkg = this.pkg;
    this.state.ready = false;
    this._syncHook(false);
    this.closing = (async () => {
        let detached = !this.embedded;
        if (this.embedded) {
            const result = await this.agent.detach().catch(() => null);
            detached = Boolean(result?.ok);
        }
        // 保留无法脱离的隐藏宿主，避免 Windows 连带销毁模拟器画面。
        if (!win.isDestroyed()) {
            if (detached) win.destroy();
            else win.hide();
        }
        if (!keepApp && pkg && this._onCloseApp) await this._onCloseApp(pkg);
    })();
    try { await this.closing; } finally { this.closing = null; }
  }

  onCloseApp(cb) { this._onCloseApp = cb; }
}

module.exports = { AppWindow, TITLEBAR_H };
