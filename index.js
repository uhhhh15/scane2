// public/extensions/third-party/scane/index.js

import {
    extension_settings,
    getContext, // 如果需要使用 context 对象，则导入
    renderExtensionTemplateAsync,
    // loadExtensionSettings // 这个函数通常由 ST 核心调用，插件一般不需要主动导入和调用
} from '../../../extensions.js';

// 从 script.js 导入
import {
    saveSettingsDebounced,
    eventSource,
    event_types, // 如果需要监听事件，则导入
    // 其他可能需要的函数，如 messageFormatting, addOneMessage 等
} from '../../../../script.js';

// 如果你的插件需要弹窗功能，从 popup.js 导入
import {
    Popup,
    POPUP_TYPE,
    callGenericPopup,
    POPUP_RESULT,
} from '../../../popup.js';

// 如果需要 UUID 或时间戳处理等工具函数，从 utils.js 导入
import {
    uuidv4,
    timestampToMoment,
} from '../../../utils.js';

// 插件的命名空间，与 manifest.json 中的文件夹名称一致
const PLUGIN_ID = 'scane2';
const PLUGIN_NAME = 'ST截图3.0';

// 插件的默认设置
const defaultSettings = {
    screenshotDelay: 10,       // 可以设置更低值，比如 0-20
    scrollDelay: 10,  
    autoInstallButtons: true, 
    altButtonLocation: true,
    screenshotScale: 2.0,      // 降低到 1.0 以提高速度
    useForeignObjectRendering: false,
    letterRendering: true,    // 新增：关闭字形渲染提高文字渲染速度
    imageTimeout: 3000,        // 新增：缩短图像加载超时
    debugOverlay: true         // 新增：是否显示进度遮罩层
};

// 全局配置对象，将从设置中加载
const config = {
    buttonClass: 'st-screenshot-button',
    chatScrollContainerSelector: '#chat', // Used for context, not direct scroll iterations for h2c
    chatContentSelector: '#chat',
    messageSelector: '.mes',
    lastMessageSelector: '.mes.last_mes',
    messageTextSelector: '.mes_block .mes_text',
    messageHeaderSelector: '.mes_block .ch_name',
    // html2canvas options will be loaded from settings
    html2canvasOptions: {
        allowTaint: true,
        useCORS: true,
        backgroundColor: null,
        logging: false,        // 始终关闭日志以提高性能
        removeContainer: true
        // 其他选项会从 settings 加载，不要在这里硬编码
    }
};

// 确保插件设置已加载并与默认值合并
function getPluginSettings() {
    extension_settings[PLUGIN_ID] = extension_settings[PLUGIN_ID] || {};
    Object.assign(extension_settings[PLUGIN_ID], { ...defaultSettings, ...extension_settings[PLUGIN_ID] });
    return extension_settings[PLUGIN_ID];
}

// 加载并应用配置
function loadConfig() {
    const settings = getPluginSettings();

    // 基本配置
    config.screenshotDelay = parseInt(settings.screenshotDelay, 10) || 0;
    config.scrollDelay = parseInt(settings.scrollDelay, 10) || 0;
    config.autoInstallButtons = settings.autoInstallButtons;
    config.altButtonLocation = settings.altButtonLocation;
    config.debugOverlay = settings.debugOverlay !== undefined ? settings.debugOverlay : true;

    // 将所有html2canvas相关设置正确地应用到 html2canvasOptions
    const loadedScale = parseFloat(settings.screenshotScale);
    if (!isNaN(loadedScale) && loadedScale > 0) {
        config.html2canvasOptions.scale = loadedScale;
    } else {
        config.html2canvasOptions.scale = defaultSettings.screenshotScale;
    }
    
    // 应用其他html2canvas设置
    config.html2canvasOptions.foreignObjectRendering = settings.useForeignObjectRendering;
    config.html2canvasOptions.letterRendering = settings.letterRendering !== undefined ? 
        settings.letterRendering : defaultSettings.letterRendering;
    config.html2canvasOptions.imageTimeout = settings.imageTimeout || defaultSettings.imageTimeout;

    console.log(`${PLUGIN_NAME}: 配置已加载并应用:`, config);
}

// === 动态加载脚本的辅助函数 (保持在 jQuery 闭包外部) ===
async function loadScript(src) {
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = src;
        script.onload = () => {
            console.log(`[${PLUGIN_NAME}] 脚本加载成功: ${src}`);
            resolve();
        };
        script.onerror = (error) => {
            console.error(`[${PLUGIN_NAME}] 脚本加载失败: ${src}`, error);
            reject(new Error(`Failed to load script: ${src}`));
        };
        document.head.appendChild(script);
    });
}

// SillyTavern 插件入口点
jQuery(async () => {
    console.log(`${PLUGIN_NAME}: 插件初始化中...`);

    // === 动态加载 html2canvas-pro.min.js ===
    try {
        // === 重点修改这里的路径 ===
        await loadScript(`scripts/extensions/third-party/${PLUGIN_ID}/html2canvas-pro.min.js`);
    } catch (error) {
        console.error(`${PLUGIN_NAME}: 无法加载 html2canvas-pro.min.js。插件功能将受限。`, error);
        return;
    }

    // 1. 加载配置（从 extension_settings）
    loadConfig();

    // 2. 注册设置面板
    // 加载设置 HTML 模板
    let settingsHtml;
    try {
        // 尝试使用正确的路径加载
        settingsHtml = await renderExtensionTemplateAsync(`third-party/${PLUGIN_ID}`, 'settings');
        console.log(`${PLUGIN_NAME}: 成功加载设置面板模板`);
    } catch (error) {
        console.error(`${PLUGIN_NAME}: 无法加载设置面板模板:`, error);
        
        // 创建内联替代模板
        settingsHtml = `
        <div id="scane2_settings">
          <h2>ST截图3.0</h2>

          <div class="option-group">
            <h3>截图操作</h3>
            <button id="st_h2c_captureLastMsgBtn" class="menu_button">截取最后一条消息</button>
          </div>

          <hr>

          <div class="option-group">
            <h3>扩展设置</h3>
            <div class="option">
              <label for="st_h2c_screenshotDelay">截图前延迟 (ms):</label>
              <input type="number" id="st_h2c_screenshotDelay" min="0" max="2000" step="50" value="${defaultSettings.screenshotDelay}">
            </div>
            <div class="option">
              <label for="st_h2c_scrollDelay">UI更新等待 (ms):</label>
              <input type="number" id="st_h2c_scrollDelay" min="0" max="2000" step="50" value="${defaultSettings.scrollDelay}">
            </div>
            <div class="option">
              <label for="st_h2c_screenshotScale">渲染比例 (Scale):</label>
              <input type="number" id="st_h2c_screenshotScale" min="0.5" max="4.0" step="0.1" value="${defaultSettings.screenshotScale}">
            </div>
            <div class="option">
              <input type="checkbox" id="st_h2c_useForeignObjectRendering" ${defaultSettings.useForeignObjectRendering ? 'checked' : ''}>
              <label for="st_h2c_useForeignObjectRendering">尝试快速模式 (兼容性低)</label>
            </div>
            <div class="option">
              <input type="checkbox" id="st_h2c_autoInstallButtons" ${defaultSettings.autoInstallButtons ? 'checked' : ''}>
              <label for="st_h2c_autoInstallButtons">自动安装消息按钮</label>
            </div>
            <div class="option">
              <input type="checkbox" id="st_h2c_altButtonLocation" ${defaultSettings.altButtonLocation ? 'checked' : ''}>
              <label for="st_h2c_altButtonLocation">按钮备用位置</label>
            </div>
            <div class="option">
              <input type="checkbox" id="st_h2c_letterRendering" ${defaultSettings.letterRendering ? 'checked' : ''}>
              <label for="st_h2c_letterRendering">字形渲染</label>
            </div>
            <div class="option">
              <input type="checkbox" id="st_h2c_debugOverlay" ${defaultSettings.debugOverlay ? 'checked' : ''}>
              <label for="st_h2c_debugOverlay">显示调试覆盖层</label>
            </div>

            <button id="st_h2c_saveSettingsBtn" class="menu_button">保存设置</button>
            <div class="status-area" id="st_h2c_saveStatus" style="display:none;"></div>
          </div>
        </div>
        `;
    }

    // 将HTML注入到SillyTavern的扩展设置面板
    $('#extensions_settings_content').append(settingsHtml);

    // 3. 绑定设置界面元素和事件
    const settingsForm = $('#extensions_settings_content'); // 确保在正确的上下文查找元素

    const screenshotDelayEl = settingsForm.find('#st_h2c_screenshotDelay');
    const scrollDelayEl = settingsForm.find('#st_h2c_scrollDelay');
    const screenshotScaleEl = settingsForm.find('#st_h2c_screenshotScale');
    const useForeignObjectRenderingEl = settingsForm.find('#st_h2c_useForeignObjectRendering');
    const autoInstallButtonsEl = settingsForm.find('#st_h2c_autoInstallButtons');
    const altButtonLocationEl = settingsForm.find('#st_h2c_altButtonLocation');
    const saveSettingsBtn = settingsForm.find('#st_h2c_saveSettingsBtn');
    const saveStatusEl = settingsForm.find('#st_h2c_saveStatus');
    const captureLastMsgBtn = settingsForm.find('#st_h2c_captureLastMsgBtn');
    const letterRenderingEl = settingsForm.find('#st_h2c_letterRendering');
    const debugOverlayEl = settingsForm.find('#st_h2c_debugOverlay');


    // 从设置中加载值到 UI
    function updateSettingsUI() {
        const settings = getPluginSettings();
        screenshotDelayEl.val(settings.screenshotDelay);
        scrollDelayEl.val(settings.scrollDelay);
        screenshotScaleEl.val(settings.screenshotScale);
        useForeignObjectRenderingEl.prop('checked', settings.useForeignObjectRendering);
        autoInstallButtonsEl.prop('checked', settings.autoInstallButtons);
        altButtonLocationEl.prop('checked', settings.altButtonLocation !== undefined ? settings.altButtonLocation : true);
        
        // 如果UI中有这些元素，设置它们的值
        if (letterRenderingEl) letterRenderingEl.prop('checked', settings.letterRendering);
        if (debugOverlayEl) debugOverlayEl.prop('checked', settings.debugOverlay);
    }

    // 保存设置
    saveSettingsBtn.on('click', () => {
        const settings = getPluginSettings(); // 获取当前设置引用

        settings.screenshotDelay = parseInt(screenshotDelayEl.val(), 10) || defaultSettings.screenshotDelay;
        settings.scrollDelay = parseInt(scrollDelayEl.val(), 10) || defaultSettings.scrollDelay;
        settings.screenshotScale = parseFloat(screenshotScaleEl.val()) || defaultSettings.screenshotScale;
        settings.useForeignObjectRendering = useForeignObjectRenderingEl.prop('checked');
        settings.autoInstallButtons = autoInstallButtonsEl.prop('checked');
        settings.altButtonLocation = altButtonLocationEl.prop('checked');
        settings.letterRendering = letterRenderingEl.prop('checked');
        settings.debugOverlay = debugOverlayEl.prop('checked');

        saveSettingsDebounced(); // 持久化设置

        saveStatusEl.text("设置已保存!").css('color', '#4cb944').show();
        setTimeout(() => saveStatusEl.hide(), 3000);

        // 重新加载配置，以便立即应用到插件逻辑
        loadConfig();
        // 根据新的 autoInstallButtons 设置，重新安装或清理按钮
        if (config.autoInstallButtons) {
            installScreenshotButtons();
        } else {
            // 如果禁用自动安装，移除所有已安装的按钮
            document.querySelectorAll(`.${config.buttonClass}`).forEach(btn => btn.remove());
        }
    });

    // "截取最后一条消息"按钮的点击事件
    captureLastMsgBtn.on('click', async () => {
        const options = {
            target: 'last',
            includeHeader: true
        };
        try {
            const dataUrl = await captureMessageWithOptions(options);
            if (dataUrl) {
                downloadImage(dataUrl, null, options.target);
            } else {
                throw new Error('未能生成截图');
            }
        } catch (error) {
            console.error('从设置面板截图失败:', error.stack || error);
            alert(`截图失败: ${error.message || '未知错误'}`);
        }
    });

    // 初始化加载设置到 UI
    updateSettingsUI();

    // 4. 初始化截图按钮（如果配置为自动安装），无需额外延迟
    if (config.autoInstallButtons) {
        installScreenshotButtons();                  // 直接安装
    } else {
        console.log(`${PLUGIN_NAME}: 自动安装截图按钮已禁用.`);
    }

    console.log(`${PLUGIN_NAME}: 插件初始化完成.`);

    // 创建并添加扩展菜单按钮
    function addExtensionMenuButton() {
        // 检查按钮是否已存在，防止重复添加
        if (document.querySelector(`#extensionsMenu .fa-camera[data-plugin-id="${PLUGIN_ID}"]`)) {
            return;
        }
        
        // 创建相机按钮
        const menuButton = document.createElement('div');
        menuButton.classList.add('fa-solid', 'fa-camera', 'extensionsMenuExtension');
        menuButton.title = PLUGIN_NAME;
        menuButton.setAttribute('data-plugin-id', PLUGIN_ID);
        
        // 添加点击事件处理器，打开自定义截图弹窗
        menuButton.addEventListener('click', () => {
            // 隐藏扩展菜单
            const extensionsMenu = document.getElementById('extensionsMenu');
            if (extensionsMenu) extensionsMenu.style.display = 'none';
            
            // 创建并显示截图功能弹窗
            showScreenshotPopup();
        });
        
        // 将按钮添加到扩展菜单
        const extensionsMenu = document.getElementById('extensionsMenu');
        if (extensionsMenu) {
            extensionsMenu.appendChild(menuButton);
        }
    }

    // 显示截图功能弹窗
    function showScreenshotPopup() {
        // 创建自定义弹窗
        const overlay = document.createElement('div');
        overlay.className = 'st-screenshot-overlay';
        overlay.style.position = 'fixed';
        overlay.style.top = '0';
        overlay.style.left = '0';
        overlay.style.width = '100%';
        overlay.style.height = '100%';
        overlay.style.backgroundColor = 'rgba(0,0,0,0.7)';
        overlay.style.zIndex = '10000';
        overlay.style.display = 'flex';
        overlay.style.justifyContent = 'center';
        overlay.style.alignItems = 'center';

        const popup = document.createElement('div');
        popup.className = 'st-screenshot-popup';
        popup.style.backgroundColor = '#2a2a2a';
        popup.style.padding = '20px';
        popup.style.borderRadius = '10px';
        popup.style.maxWidth = '300px';
        popup.style.width = '100%';

        // 添加选项
        const options = [
            { id: 'last_msg', icon: 'fa-camera', text: '截取最后一条消息' },
            { id: 'conversation', icon: 'fa-images', text: '截取整个对话' },
            { id: 'settings', icon: 'fa-gear', text: '调整截图设置' }
        ];
        
        options.forEach(option => {
            const btn = document.createElement('div');
            btn.className = 'st-screenshot-option';
            btn.style.display = 'flex';
            btn.style.alignItems = 'center';
            btn.style.gap = '10px';
            btn.style.padding = '12px';
            btn.style.margin = '8px 0';
            btn.style.borderRadius = '5px';
            btn.style.cursor = 'pointer';
            btn.style.backgroundColor = '#3a3a3a';
            
            btn.innerHTML = `
                <i class="fa-solid ${option.icon}" style="font-size: 1.2em;"></i>
                <span>${option.text}</span>
            `;
            
            // 悬停效果
            btn.addEventListener('mouseover', () => btn.style.backgroundColor = '#4a4a4a');
            btn.addEventListener('mouseout', () => btn.style.backgroundColor = '#3a3a3a');
            
            // 点击事件
            btn.addEventListener('click', async () => {
                console.log(`[${PLUGIN_NAME}] ${option.id} clicked`);
                document.body.removeChild(overlay);
                
                try {
                    switch(option.id) {
                        case 'last_msg':
                            const dataUrl = await captureMessageWithOptions({
                                target: 'last',
                                includeHeader: true
                            });
                            if (dataUrl) downloadImage(dataUrl, null, 'last_message');
                            break;
                        case 'conversation':
                            const convDataUrl = await captureMessageWithOptions({
                                target: 'conversation',
                                includeHeader: true
                            });
                            if (convDataUrl) downloadImage(convDataUrl, null, 'conversation');
                            break;
                        case 'settings':
                            showSettingsPopup();
                            break;
                    }
                } catch (error) {
                    console.error(`[${PLUGIN_NAME}] 操作失败:`, error);
                    alert(`操作失败: ${error.message || '未知错误'}`);
                }
            });
            
            popup.appendChild(btn);
        });
        
        overlay.appendChild(popup);
        document.body.appendChild(overlay);
        
        // 点击空白区域关闭弹窗
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) document.body.removeChild(overlay);
        });
    }

    // 调用添加按钮函数或使用MutationObserver确保菜单加载完成
    function waitForExtensionsMenu() {
        if (document.getElementById('extensionsMenu')) {
            addExtensionMenuButton();
            return;
        }
        
        const observer = new MutationObserver((mutations, obs) => {
            if (document.getElementById('extensionsMenu')) {
                addExtensionMenuButton();
                obs.disconnect();
            }
        });
        
        observer.observe(document.body, {
            childList: true,
            subtree: true
        });
    }

    // 启动观察器
    waitForExtensionsMenu();
});


// --- 辅助函数：准备单个元素给 html2canvas-pro (通过克隆到临时容器) ---
function prepareSingleElementForHtml2CanvasPro(originalElement) {
    if (!originalElement) return null;

    const element = originalElement.cloneNode(true);
    
    // 移除所有按钮区域
    element.querySelectorAll('.mes_buttons').forEach(buttonsArea => {
        if (buttonsArea && buttonsArea.parentNode) {
            buttonsArea.parentNode.removeChild(buttonsArea);
        }
    });
    
    // 新增：移除消息元数据显示元素（ID、时间、令牌计数）
    const metaSelectors = [
        '.mesIDDisplay', 
        '.mes_timer', 
        '.tokenCounterDisplay'
    ];
    
    metaSelectors.forEach(selector => {
        element.querySelectorAll(selector).forEach(metaEl => {
            if (metaEl && metaEl.parentNode) {
                metaEl.parentNode.removeChild(metaEl);
            }
        });
    });

    // 删除无需渲染的标签
    element.querySelectorAll('script, style, noscript, iframe, canvas').forEach(el => el.remove());
    
    // 为已知问题元素添加样式修复
    element.querySelectorAll('.mes_reasoning, .mes_reasoning_delete, .mes_reasoning_edit_cancel').forEach(el => {
        if (el && el.style) {
            const style = el.style;
            style.removeProperty('color');
            style.removeProperty('background-color');
            style.removeProperty('border-color');
        }
    });
    
    return element;
}


// 核心截图函数：创建一个临时容器，放入净化后的元素，然后渲染容器
async function captureElementWithHtml2Canvas(elementToCapture, h2cUserOptions = {}) {
    console.log('Preparing to capture element with html2canvas-pro v5:', elementToCapture);
    
    // 条件性创建遮罩层
    let overlay = null;
    if (config.debugOverlay) {
        overlay = createOverlay('使用 html2canvas-pro 准备截图...');
        document.body.appendChild(overlay);
    }
    
    const topSettingsHolder = document.querySelector("#top-settings-holder");
    const formSheld = document.querySelector("#form_sheld");
    const elementsToHide = [topSettingsHolder, formSheld, overlay].filter(el => el);
    const originalDisplays = new Map();
    let dataUrl = null;

    const tempContainer = document.createElement('div');
    tempContainer.style.position = 'absolute';
    tempContainer.style.left = '-9999px';
    tempContainer.style.top = '-9999px';
    tempContainer.style.padding = '10px';

    // --- 健壮性检查并获取聊天容器用于确定宽度和背景 ---
    const chatSelector = config.chatContentSelector;
    let chatContentEl = null;
    if (typeof chatSelector === 'string' && chatSelector) {
       chatContentEl = document.querySelector(chatSelector);
    } else {
       console.warn("config.chatContentSelector is invalid:", chatSelector, ". Cannot find chat container for width/background.");
    }
    // --- End 健壮性检查 ---

    let containerWidth = 'auto';
    if (chatContentEl) {
        containerWidth = chatContentEl.clientWidth + 'px';
    } else if (elementToCapture) {
        containerWidth = elementToCapture.offsetWidth + 'px';
    }
    tempContainer.style.width = containerWidth;

    let chatBgColor = '#1e1e1e';
    if(chatContentEl) {
        const chatStyle = window.getComputedStyle(chatContentEl);
        if (chatStyle.backgroundColor && chatStyle.backgroundColor !== 'rgba(0, 0, 0, 0)' && chatStyle.backgroundColor !== 'transparent') {
            chatBgColor = chatStyle.backgroundColor;
        } else {
             const bodyBgVar = getComputedStyle(document.body).getPropertyValue('--pcb');
             if (bodyBgVar && bodyBgVar.trim() !== '') {
                 chatBgColor = bodyBgVar.trim();
             }
        }
    }
    tempContainer.style.backgroundColor = chatBgColor;


    let preparedElement;
    try {
        if (overlay) updateOverlay(overlay, '准备元素结构...', 0.05);
        preparedElement = prepareSingleElementForHtml2CanvasPro(elementToCapture);
        if (!preparedElement) throw new Error("Failed to prepare element for capture.");

        tempContainer.appendChild(preparedElement);
        document.body.appendChild(tempContainer);

        // 只有当有设置延迟时才等待
        if (config.screenshotDelay > 0) {
            await new Promise(resolve => setTimeout(resolve, config.screenshotDelay));
        }

    } catch (e) {
        console.error("Error during element preparation (pro v5):", e);
        if (overlay && document.body.contains(overlay)) {
             if (originalDisplays.has(overlay)) overlay.style.display = originalDisplays.get(overlay) || 'flex';
             updateOverlay(overlay, `净化错误: ${e.message.substring(0, 60)}...`, 0);
        }
        if (tempContainer && tempContainer.parentElement === document.body) {
           document.body.removeChild(tempContainer);
        }
        throw e;
    }

    try {
        if (overlay) updateOverlay(overlay, '正在渲染...', 0.3);
        
        const finalH2cOptions = {...config.html2canvasOptions, ...h2cUserOptions};
        finalH2cOptions.ignoreElements = (element) => {
            // 已有的忽略条件
            if (element.id === 'top-settings-holder' || 
                element.id === 'form_sheld' || 
                element.classList.contains('st-capture-overlay')) {
                return true;
            }
            
            // 添加新的忽略条件 - 使用类组合更可靠
            if (element.classList && 
                element.classList.contains('flex-container') && 
                element.classList.contains('swipeRightBlock') && 
                element.classList.contains('flexFlowColumn') && 
                element.classList.contains('flexNoGap')) {
                return true;
            }
            
            // 新增: 更精确地忽略表情框相关元素
            try {
                // 检查是否是聊天区域内的表情元素
                if (element.closest('#chat')) {
                    // 检查元素是否匹配特定结构
                    const isEmotionElement = 
                        // 检查是否是div[4]/div[1]/div[2]结构
                        (element.parentElement && 
                         element.parentElement.parentElement && 
                         element.parentElement.parentElement.matches('div[class*="mes"] > div[class*="mes_block"] > div')) ||
                        // 或者检查元素是否是表情容器
                        element.matches('.expression_box, .expression-container, [data-emotion]') ||
                        // 或者检查元素是否包含表情相关内容
                        (element.querySelector && element.querySelector('.expression_box, .expression-container, [data-emotion]'));
                        
                    if (isEmotionElement) {
                        return true;
                    }
                }
            } catch (e) {
                // 忽略可能的错误
                console.debug('Expression element check error:', e);
            }
            
            return false;
        };

        console.log('h2c opts:', finalH2cOptions);

        // 使用临时容器进行渲染，确保清理后的DOM结构
        const canvas = await html2canvas(tempContainer, finalH2cOptions);
        
        if (overlay) updateOverlay(overlay, '生成图像数据...', 0.8);
        dataUrl = canvas.toDataURL('image/png');

    } catch (error) {
        console.error('html2canvas-pro 截图失败:', error.stack || error);
        if (overlay && document.body.contains(overlay)) {
             const errorMsg = error && error.message ? error.message : "未知渲染错误";
             if (originalDisplays.has(overlay)) overlay.style.display = originalDisplays.get(overlay) || 'flex';
             updateOverlay(overlay, `渲染错误 (pro v5): ${errorMsg.substring(0, 60)}...`, 0);
        }
        throw error;
    } finally {
        if (tempContainer && tempContainer.parentElement === document.body) {
           document.body.removeChild(tempContainer);
        }
        if (overlay && document.body.contains(overlay)) {
            if (!dataUrl) {
                setTimeout(() => { if(document.body.contains(overlay)) document.body.removeChild(overlay); }, 3000);
            } else {
               if (originalDisplays.has(overlay)) overlay.style.display = originalDisplays.get(overlay) || 'flex';
               updateOverlay(overlay, '截图完成!', 1);
               setTimeout(() => { if(document.body.contains(overlay)) document.body.removeChild(overlay); }, 1200);
            }
        }
    }
    if (!dataUrl) throw new Error("html2canvas-pro 未能生成图像数据。");
    console.log("DEBUG: html2canvas-pro capture successful.");
    return dataUrl;
}

// This function is specifically for capturing multiple messages (or the whole conversation)
// It creates a temporary container, adds prepared clones of multiple messages, then renders the container.
async function captureMultipleMessagesWithHtml2Canvas(messagesToCapture, actionHint, h2cUserOptions = {}) {
    if (!messagesToCapture || messagesToCapture.length === 0) {
        throw new Error("没有提供消息给 captureMultipleMessagesWithHtml2Canvas");
    }
    console.log(`[captureMultipleMessagesWithHtml2Canvas-pro v5] Capturing ${messagesToCapture.length} messages. Hint: ${actionHint}`);

    const overlay = createOverlay(`组合 ${messagesToCapture.length} 条消息 (pro v5)...`);
    document.body.appendChild(overlay);

    const topSettingsHolder = document.querySelector("#top-settings-holder");
    const formSheld = document.querySelector("#form_sheld");
    const elementsToHide = [topSettingsHolder, formSheld, overlay].filter(el => el);
    const originalDisplays = new Map();
    let dataUrl = null;

    const tempContainer = document.createElement('div');
    tempContainer.style.position = 'absolute';
    tempContainer.style.left = '-9999px';
    tempContainer.style.top = '-9999px';
    tempContainer.style.padding = '10px';

    // --- 健壮性检查并获取聊天容器用于确定宽度和背景 ---
    const chatSelector = config.chatContentSelector;
    let chatContentEl = null;
    if (typeof chatSelector === 'string' && chatSelector) {
       chatContentEl = document.querySelector(chatSelector);
    } else {
       console.warn("config.chatContentSelector is invalid:", chatSelector, ". Cannot find chat container for width/background.");
    }
    // --- End 健壮性检查 ---

    let containerWidth = 'auto';
    if (chatContentEl) {
        containerWidth = chatContentEl.clientWidth + 'px';
    } else if (messagesToCapture.length > 0) {
        containerWidth = messagesToCapture[0].offsetWidth + 'px';
    }
    tempContainer.style.width = containerWidth;

    let chatBgColor = '#1e1e1e';
    if(chatContentEl) {
        const chatStyle = window.getComputedStyle(chatContentEl);
        if (chatStyle.backgroundColor && chatStyle.backgroundColor !== 'rgba(0, 0, 0, 0)' && chatStyle.backgroundColor !== 'transparent') {
            chatBgColor = chatStyle.backgroundColor;
        } else {
             const bodyBgVar = getComputedStyle(document.body).getPropertyValue('--pcb');
             if (bodyBgVar && bodyBgVar.trim() !== '') {
                 chatBgColor = bodyBgVar.trim();
             }
        }
    }
    tempContainer.style.backgroundColor = chatBgColor;


    updateOverlay(overlay, `准备 ${messagesToCapture.length} 条消息 (pro v5)...`, 0.05);
    messagesToCapture.forEach(msg => {
        try {
            // Use the simplified preparation function for each message clone
            const preparedClone = prepareSingleElementForHtml2CanvasPro(msg);
            if (preparedClone) {
                tempContainer.appendChild(preparedClone);
            } else {
                 console.warn("Skipping null prepared clone for message:", msg);
            }
        } catch (e) {
            console.error("Error preparing message for multi-capture (pro v5):", msg, e);
            // Decide whether to skip this message or re-throw to stop the whole process
            // For now, we log and continue.
        }
    });
    document.body.appendChild(tempContainer);
    // Give cloned and prepared elements time to settle and render within the tempContainer
    await new Promise(resolve => setTimeout(resolve, config.screenshotDelay));

    try {
        updateOverlay(overlay, '正在渲染…', 0.3);

        const finalH2cOptions = {...config.html2canvasOptions, ...h2cUserOptions};
        finalH2cOptions.ignoreElements = (element) => {
            // 已有的忽略条件
            if (element.id === 'top-settings-holder' || 
                element.id === 'form_sheld' || 
                element.classList.contains('st-capture-overlay')) {
                return true;
            }
            
            // 添加新的忽略条件 - 使用类组合更可靠
            if (element.classList && 
                element.classList.contains('flex-container') && 
                element.classList.contains('swipeRightBlock') && 
                element.classList.contains('flexFlowColumn') && 
                element.classList.contains('flexNoGap')) {
                return true;
            }
            
            // 新增: 更精确地忽略表情框相关元素
            try {
                // 检查是否是聊天区域内的表情元素
                if (element.closest('#chat')) {
                    // 检查元素是否匹配特定结构
                    const isEmotionElement = 
                        // 检查是否是div[4]/div[1]/div[2]结构
                        (element.parentElement && 
                         element.parentElement.parentElement && 
                         element.parentElement.parentElement.matches('div[class*="mes"] > div[class*="mes_block"] > div')) ||
                        // 或者检查元素是否是表情容器
                        element.matches('.expression_box, .expression-container, [data-emotion]') ||
                        // 或者检查元素是否包含表情相关内容
                        (element.querySelector && element.querySelector('.expression_box, .expression-container, [data-emotion]'));
                        
                    if (isEmotionElement) {
                        return true;
                    }
                }
            } catch (e) {
                // 忽略可能的错误
                console.debug('Expression element check error:', e);
            }
            
            return false;
        };

        console.log("DEBUG: html2canvas-pro (multiple) options:", finalH2cOptions);
        const canvas = await html2canvas(tempContainer, finalH2cOptions);

        updateOverlay(overlay, '生成图像数据...', 0.8);
        dataUrl = canvas.toDataURL('image/png');

    } catch (error) {
        console.error('html2canvas-pro 多消息截图失败:', error.stack || error);
         if (overlay && document.body.contains(overlay)) {
             const errorMsg = error && error.message ? error.message : "未知渲染错误";
             if (originalDisplays.has(overlay)) overlay.style.display = originalDisplays.get(overlay) || 'flex';
             updateOverlay(overlay, `多消息渲染错误 (pro v5): ${errorMsg.substring(0,50)}...`, 0);
        }
        throw error;
    } finally {
        if (tempContainer && tempContainer.parentElement === document.body) {
            document.body.removeChild(tempContainer);
        }
        if (overlay && document.body.contains(overlay)) {
            if (!dataUrl) {
                 setTimeout(() => {if(document.body.contains(overlay)) document.body.removeChild(overlay);}, 3000);
            } else {
                if (originalDisplays.has(overlay)) overlay.style.display = originalDisplays.get(overlay) || 'flex';
                updateOverlay(overlay, '截图完成!', 1);
                setTimeout(() => {if(document.body.contains(overlay)) document.body.removeChild(overlay);}, 1200);
            }
        }
    }
    if (!dataUrl) throw new Error("html2canvas-pro 未能生成多消息图像数据。");
    console.log("DEBUG: html2canvas-pro multiple messages capture successful.");
    return dataUrl;
}


// This function routes capture requests based on target ('last', 'selected', 'conversation')
// It calls the appropriate html2canvas-pro capture function.
async function captureMessageWithOptions(options) {
    const { target, includeHeader } = options;
    console.log('captureMessageWithOptions (html2canvas-pro v5) called with:', options);

    // --- 健壮性检查并获取聊天容器 ---
    const chatSelector = config.chatContentSelector;
    if (typeof chatSelector !== 'string' || !chatSelector) {
         const errorMsg = `聊天内容容器选择器无效: '${chatSelector}'`;
         console.error(`${PLUGIN_NAME}:`, errorMsg);
         throw new Error(errorMsg); // Throw the specific error here
    }
    const chatContentEl = document.querySelector(chatSelector);
    if (!chatContentEl) {
         const errorMsg = `聊天内容容器 '${chatSelector}' 未找到!`;
         console.error(`${PLUGIN_NAME}:`, errorMsg);
         throw new Error(errorMsg); // Throw the specific error here
    }
    // --- End 健壮性检查 ---


    let elementToRender;
    let messagesForMultiCapture = [];

    switch (target) {
        case 'last':
            elementToRender = chatContentEl.querySelector(config.lastMessageSelector);
            if (!elementToRender) throw new Error('最后一条消息元素未找到');
            break;
        case 'selected':
            elementToRender = chatContentEl.querySelector(`${config.messageSelector}[data-selected="true"]`) || chatContentEl.querySelector(`${config.messageSelector}.selected`);
            if (!elementToRender) throw new Error('没有选中的消息');
            break;
        case 'conversation':
            messagesForMultiCapture = Array.from(chatContentEl.querySelectorAll(config.messageSelector));
            if (messagesForMultiCapture.length === 0) throw new Error("对话中没有消息可捕获。");
            // For 'conversation', we use the multi-message handler on all messages
            return await captureMultipleMessagesWithHtml2Canvas(messagesForMultiCapture, "conversation_all", {});
        default:
            throw new Error('未知的截图目标类型');
    }

    if (!elementToRender && messagesForMultiCapture.length === 0) {
         throw new Error(`目标元素未找到 (for ${target} within ${chatSelector})`); // Use checked selector
    }

    // If a single element target was found and it's not a conversation
    if (elementToRender) {
        let finalElementToCapture = elementToRender;
        // If includeHeader is false and target is not 'conversation', capture only the text part
        if (!includeHeader && target !== 'conversation' && elementToRender.querySelector(config.messageTextSelector)) {
            const textElement = elementToRender.querySelector(config.messageTextSelector);
            if (textElement) {
                finalElementToCapture = textElement;
                console.log('Capturing text element only with html2canvas-pro v5:', finalElementToCapture);
            } else {
                console.warn("Could not find text element for includeHeader: false, capturing full message.");
            }
        }
        // Call the single element capture function, which now uses a temp container internally
        return await captureElementWithHtml2Canvas(finalElementToCapture, {});
    }
    // Should not reach here if logic is correct, 'conversation' returns early.
    throw new Error("captureMessageWithOptions (h2c-pro v5): Unhandled capture scenario.");
}

// Installs the screenshot buttons on messages
function installScreenshotButtons() {
    // Remove existing buttons first to prevent duplicates
    document.querySelectorAll(`.${config.buttonClass}`).forEach(btn => btn.remove());

    // --- 健壮性检查并获取聊天容器 ---
    const chatSelector = config.chatContentSelector;
    if (typeof chatSelector !== 'string' || !chatSelector) {
         console.error(`${PLUGIN_NAME}: 无法安装按钮，聊天内容容器选择器无效:`, chatSelector);
         return false; // Cannot install buttons if selector is bad
    }
    const chatContentEl = document.querySelector(chatSelector);
    if (chatContentEl) {
        // Add buttons to existing messages
        chatContentEl.querySelectorAll(config.messageSelector).forEach(message => addScreenshotButtonToMessage(message));
    } else {
        console.warn(`Chat content ('${chatSelector}') not found for initial button installation.`);
    }
    // --- End 健壮性检查 ---


    // Use MutationObserver to add buttons to new messages as they are added
    const observer = new MutationObserver(mutations => {
      mutations.forEach(mutation => {
        if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
          mutation.addedNodes.forEach(node => {
            if (node.nodeType === Node.ELEMENT_NODE) {
              // Check if the added node is a message itself
              if (node.matches(config.messageSelector)) {
                addScreenshotButtonToMessage(node);
              }
              // Check if the added node contains messages (e.g., chunk of messages added)
              else if (node.querySelectorAll) {
                node.querySelectorAll(config.messageSelector).forEach(addScreenshotButtonToMessage);
              }
            }
          });
        }
      });
    });

    // Observe the chat content element for changes
    if (chatContentEl) {
      observer.observe(chatContentEl, { childList: true, subtree: true });
    } else {
      console.warn(`Chat content ('${chatSelector}') not found for MutationObserver.`);
    }
    console.log(`${PLUGIN_NAME}: 截图按钮安装逻辑已执行。`);
    return true;
}

// Adds a screenshot button to a single message element
function addScreenshotButtonToMessage(messageElement) {
    // 防止添加重复按钮或添加到非消息元素
    if (!messageElement || !messageElement.querySelector || messageElement.querySelector(`.${config.buttonClass}`)) {
      return;
    }

    // 先找到最外层的消息按钮容器
    let buttonsContainer = messageElement.querySelector('.mes_block .ch_name.flex-container.justifySpaceBetween .mes_buttons');
    if (!buttonsContainer) {
      buttonsContainer = messageElement.querySelector('.mes_block .mes_buttons');
      if (!buttonsContainer) {
        return;  // 如果找不到任何按钮容器，则退出
      }
    }

    // 创建截图按钮元素
    const screenshotButton = document.createElement('div');
    screenshotButton.innerHTML = '<i class="fa-solid fa-camera"></i>';
    screenshotButton.className = `${config.buttonClass} mes_button interactable`; 
    screenshotButton.title = '截图此消息 (长按显示更多选项)';
    screenshotButton.setAttribute('tabindex', '0');
    screenshotButton.style.cursor = 'pointer';

    // --- Context Menu Logic ---
    const contextMenu = document.createElement('div');
    contextMenu.className = 'st-screenshot-context-menu';
    // Apply basic styles directly or via CSS class
    Object.assign(contextMenu.style, { display: 'none', position: 'absolute', zIndex: '10000', background: '#2a2a2a', border: '1px solid #555', borderRadius: '4px', boxShadow: '0 2px 10px rgba(0,0,0,0.3)', padding: '5px 0' });

    // Define menu options for multi-message capture
    const menuOptions = [
      { text: '截取前两条消息', action: 'prev2' },
      { text: '截取前一条消息', action: 'prev1' },
      { text: '截取后一条消息', action: 'next1' },
      { text: '截取后两条消息', action: 'next2' }
    ];

    // Create menu items
    menuOptions.forEach(option => {
      const menuItem = document.createElement('div');
      menuItem.className = 'st-screenshot-menu-item';
      menuItem.textContent = option.text;
      Object.assign(menuItem.style, { padding: '8px 12px', cursor: 'pointer', whiteSpace: 'nowrap', transition: 'background-color 0.2s' });
      // Add hover effect
      menuItem.onmouseover = () => menuItem.style.backgroundColor = '#3a3a3a';
      menuItem.onmouseout = () => menuItem.style.backgroundColor = 'transparent';

      // Add click listener for menu item
      menuItem.onclick = async (e) => {
        e.stopPropagation(); // Prevent the click from closing the menu immediately via document listener
        hideContextMenu(); // Hide the menu
        // Call the multi-message capture handler with the selected action
        await captureMultipleMessagesFromContextMenu(messageElement, option.action);
      };
      contextMenu.appendChild(menuItem);
    });
    // Append menu to the body (or a suitable container)
    document.body.appendChild(contextMenu);

    // Variables for long-press detection
    let pressTimer;
    let isLongPress = false;

    // Functions to show/hide the context menu
    function showContextMenu(x, y) {
      contextMenu.style.display = 'block';
      // Position the menu, ensuring it stays within the viewport
      const vpW = window.innerWidth;
      const vpH = window.innerHeight;
      const menuW = contextMenu.offsetWidth;
      const menuH = contextMenu.offsetHeight;

      // Adjust coordinates if menu goes off-screen
      if (x + menuW > vpW) x = vpW - menuW - 5;
      if (y + menuH > vpH) y = vpH - menuH - 5;
      // Prevent menu from going off the top edge
      if (y < 0) y = 5;


      contextMenu.style.left = `${x}px`;
      contextMenu.style.top = `${y}px`;
       console.log(`DEBUG: Showing context menu at ${x}, ${y}`);
    }

    function hideContextMenu() {
      contextMenu.style.display = 'none';
       console.log('DEBUG: Hiding context menu');
    }

    // Add long-press and click event listeners to the button
    screenshotButton.addEventListener('mousedown', (e) => {
      // Only trigger long press on left click
      if (e.button !== 0) return;
      isLongPress = false; // Reset state
      pressTimer = setTimeout(() => {
        isLongPress = true;
        const rect = screenshotButton.getBoundingClientRect();
        // Position menu below the button
        showContextMenu(rect.left, rect.bottom + 5);
      }, 500); // 500ms to trigger long press
    });

    screenshotButton.addEventListener('mouseup', () => clearTimeout(pressTimer)); // Clear timer on mouse up
    screenshotButton.addEventListener('mouseleave', () => clearTimeout(pressTimer)); // Clear timer if mouse leaves button

    // Hide menu when clicking anywhere else on the document
    document.addEventListener('click', (e) => {
      // Check if the menu is visible and the click was outside the menu AND outside the button itself
      if (contextMenu.style.display === 'block' && !contextMenu.contains(e.target) && !screenshotButton.contains(e.target)) {
          hideContextMenu();
      }
    });

    // Prevent context menu from appearing on right-click on the button itself
    screenshotButton.addEventListener('contextmenu', (e) => {
        e.preventDefault();
    });

    // 添加触摸事件支持
    screenshotButton.addEventListener('touchstart', (e) => {
      e.preventDefault(); // 防止默认行为
      isLongPress = false;
      pressTimer = setTimeout(() => {
        isLongPress = true;
        const rect = screenshotButton.getBoundingClientRect();
        showContextMenu(rect.left, rect.bottom + 5);
      }, 500);
    });

    screenshotButton.addEventListener('touchend', () => clearTimeout(pressTimer)); // 触摸结束时清除计时器
    screenshotButton.addEventListener('touchcancel', () => clearTimeout(pressTimer)); // 触摸取消时清除计时器

    // Add the primary click event listener for single message capture
    screenshotButton.addEventListener('click', async function(event) {
      event.preventDefault(); // Prevent any default behavior
      event.stopPropagation(); // Prevent event from bubbling up

      // If a long press occurred, the menu was shown, so don't trigger single capture
      if (isLongPress) {
        isLongPress = false; // Reset state
        return;
      }

      // Prevent multiple clicks while loading
      if (this.classList.contains('loading')) return;

      // Add loading indicator
      const iconElement = this.querySelector('i');
      const originalIconClass = iconElement ? iconElement.className : '';
      if (iconElement) iconElement.className = `fa-solid fa-spinner fa-spin ${config.buttonClass}-icon-loading`;
      this.classList.add('loading');

      try {
        // For a single button click, capture the messageElement itself
        // includeHeader is implicitly true as we capture the whole messageElement
        // This now calls the function that uses a temporary container internally
        const dataUrl = await captureElementWithHtml2Canvas(messageElement, {});
        downloadImage(dataUrl, messageElement, 'message'); // Download the resulting image
      } catch (error) {
        console.error('消息截图失败 (h2c-pro button click v5):', error.stack || error);
        alert(`截图失败: ${error.message || '未知错误'}`);
      } finally {
        // Remove loading indicator
        if (iconElement) iconElement.className = originalIconClass;
        this.classList.remove('loading');
      }
    });

    // 找到extraMesButtons容器和编辑按钮
    const extraMesButtons = buttonsContainer.querySelector('.extraMesButtons.visible');
    const editButton = buttonsContainer.querySelector('.mes_button.mes_edit.fa-solid.fa-pencil.interactable');
    
    // 确认找到了两个元素，插入按钮到它们之间
    if (extraMesButtons && editButton) {
      // 直接在编辑按钮前插入截图按钮
      editButton.insertAdjacentElement('beforebegin', screenshotButton);
    } else {
      // 如果找不到这两个元素，使用备用方案
      const existingButton = buttonsContainer.querySelector('.fa-edit, .mes_edit');
      if (existingButton) {
        existingButton.insertAdjacentElement('beforebegin', screenshotButton);
      } else {
        buttonsContainer.appendChild(screenshotButton);
      }
    }
}

// Handles requests from the long-press context menu to capture multiple messages
async function captureMultipleMessagesFromContextMenu(currentMessageElement, action) { // Renamed for clarity
    console.log(`[多消息截图 ctx menu h2c-pro v5] Action: ${action} from msg:`, currentMessageElement);
    // Find the screenshot button on the current message to apply loading state
    const button = currentMessageElement.querySelector(`.${config.buttonClass}`);
    const iconElement = button ? button.querySelector('i') : null;
    const originalIconClass = iconElement ? iconElement.className : '';

    if (button) button.classList.add('loading');
    if (iconElement) iconElement.className = `fa-solid fa-spinner fa-spin ${config.buttonClass}-icon-loading`;

    try {
        // --- 健壮性检查并获取聊天容器 ---
        const chatSelector = config.chatContentSelector;
        if (typeof chatSelector !== 'string' || !chatSelector) {
             const errorMsg = `无法进行多消息截图，聊天内容容器选择器无效: '${chatSelector}'`;
             console.error(`${PLUGIN_NAME}:`, errorMsg);
             throw new Error(errorMsg);
        }
        const chatContent = document.querySelector(chatSelector);
        if (!chatContent) {
             const errorMsg = `无法进行多消息截图，聊天内容容器 '${chatSelector}' 未找到!`;
             console.error(`${PLUGIN_NAME}:`, errorMsg);
             throw new Error(errorMsg);
        }
        // --- End 健壮性检查 ---


        // Get all message elements in the chat
        let allMessages = Array.from(chatContent.querySelectorAll(config.messageSelector));
        // Find the index of the current message
        let currentIndex = allMessages.indexOf(currentMessageElement);
        if (currentIndex === -1) throw new Error('无法确定当前消息位置');

        // Determine the range of messages to capture based on the action
        let startIndex = currentIndex;
        let endIndex = currentIndex;
        switch (action) {
            case 'prev2': startIndex = Math.max(0, currentIndex - 2); break;
            case 'prev1': startIndex = Math.max(0, currentIndex - 1); break;
            case 'next1': endIndex = Math.min(allMessages.length - 1, currentIndex + 1); break;
            case 'next2': endIndex = Math.min(allMessages.length - 1, currentIndex + 2); break;
            default: throw new Error(`未知多消息截图动作: ${action}`);
        }

        // Extract the target message elements
        const targetMessages = allMessages.slice(startIndex, endIndex + 1);
        if (targetMessages.length === 0) throw new Error('无法获取目标消息进行多条截图');

        // Call the multi-message html2canvas-pro capture function, which uses a temporary container internally
        const dataUrl = await captureMultipleMessagesWithHtml2Canvas(targetMessages, action, {});

        // Download the resulting image
        if (dataUrl) {
            const actionTextMap = {'prev2':'前两条','prev1':'前一条','next1':'后一条','next2':'后两条'};
            const fileNameHint = `ST消息组_${actionTextMap[action] || action}`;
            downloadImage(dataUrl, currentMessageElement, fileNameHint);
            console.log(`[多消息截图 ctx menu h2c-pro v5] 截图成功 for ${action}`);
        } else {
            throw new Error('多消息截图 html2canvas-pro 生成失败');
        }
    } catch (error) {
        console.error(`[多消息截图 ctx menu h2c-pro v5] 失败 (${action}):`, error.stack || error);
        alert(`截图 (${action}) 失败: ${error.message || '未知错误'}`);
    } finally {
        // Remove loading indicator
        if (iconElement) iconElement.className = originalIconClass;
        if (button) button.classList.remove('loading');
        console.log(`[多消息截图 ctx menu h2c-pro v5] 完成 (${action})`);
    }
}


// Utility function to download a data URL as a PNG file
function downloadImage(dataUrl, messageElement = null, typeHint = 'screenshot') {
    const link = document.createElement('a');
    // Sanitize typeHint for use in filename
    let filename = `SillyTavern_${typeHint.replace(/[^a-z0-9_-]/gi, '_')}`;

    // Attempt to generate a more specific filename if a message element is provided
    if (messageElement && typeof messageElement.querySelector === 'function') {
      const nameSelector = config.messageHeaderSelector + ' .name_text';
      const nameFallbackSelector = config.messageHeaderSelector;
      const nameTextElement = messageElement.querySelector(nameSelector) || messageElement.querySelector(nameFallbackSelector);
      let senderName = 'Character'; // Default sender name
      if (nameTextElement && nameTextElement.textContent) {
          senderName = nameTextElement.textContent.trim() || 'Character';
      }
      // Determine if it's a user message
      const isUser = messageElement.classList.contains('user_mes') || (messageElement.closest && messageElement.closest('.user_mes'));
      const sender = isUser ? 'User' : senderName;

      // Get message ID (fallback to timestamp part if not available)
      const msgIdData = messageElement.getAttribute('mesid') || messageElement.dataset.msgId || messageElement.id;
      const msgId = msgIdData ? msgIdData.slice(-5) : ('m' + Date.now().toString().slice(-8, -4)); // Use last 5 chars of mesid/data-msg-id/id, or part of timestamp

      // Get timestamp (fallback to current time) and format it
      const timestampAttr = messageElement.dataset.timestamp || messageElement.getAttribute('data-timestamp') || new Date().toISOString();
      const timestamp = timestampAttr.replace(/[:\sTZ.]/g, '_').replace(/__+/g, '_'); // Format timestamp for filename

      // Create filename with sender, message ID, and timestamp
      const filenameSafeSender = sender.replace(/[^a-z0-9_-]/gi, '_').substring(0, 20); // Sanitize and shorten sender name
      filename = `SillyTavern_${filenameSafeSender}_${msgId}_${timestamp}`;
    } else {
      // Fallback filename with just type hint and timestamp
      filename += `_${new Date().toISOString().replace(/[:.TZ]/g, '-')}`;
    }

    // Set download filename and trigger download
    link.download = `${filename}.png`; // Always download as PNG
    link.href = dataUrl;
    link.click();
    console.log(`Image downloaded as ${filename}.png`);
}

// Utility function to create the capture overlay
function createOverlay(message) {
    const overlay = document.createElement('div');
    overlay.className = 'st-capture-overlay'; // Use CSS class for styling
    const statusBox = document.createElement('div');
    statusBox.className = 'st-capture-status'; // Use CSS class for styling
    const messageP = document.createElement('p');
    messageP.textContent = message;
    statusBox.appendChild(messageP);
    const progressContainer = document.createElement('div');
    progressContainer.className = 'st-progress'; // Use CSS class for styling
    const progressBar = document.createElement('div');
    progressBar.className = 'st-progress-bar'; // Use CSS class for styling
    progressBar.style.width = '0%'; // Initial progress
    progressContainer.appendChild(progressBar);
    statusBox.appendChild(progressContainer);
    overlay.appendChild(statusBox);
    return overlay;
}

// Utility function to update the message and progress in the overlay
function updateOverlay(overlay, message, progressRatio) {
    // Check if overlay element is still valid and in the document
    if (!overlay || !overlay.parentNode) return;
    const messageP = overlay.querySelector('.st-capture-status p');
    const progressBar = overlay.querySelector('.st-progress-bar');
    if (messageP) messageP.textContent = message;
    // Ensure progressRatio is between 0 and 1
    const safeProgress = Math.max(0, Math.min(1, progressRatio));
    if (progressBar) progressBar.style.width = `${Math.round(safeProgress * 100)}%`;
}

// 新增一个自定义设置弹窗
function showSettingsPopup() {
    // 获取当前设置
    const settings = getPluginSettings();
    
    // 创建自定义弹窗
    const overlay = document.createElement('div');
    overlay.className = 'st-settings-overlay';
    overlay.style.position = 'fixed';
    overlay.style.top = '0';
    overlay.style.left = '0';
    overlay.style.width = '100%';
    overlay.style.height = '100%';
    overlay.style.backgroundColor = 'rgba(0,0,0,0.7)';
    overlay.style.zIndex = '10000';
    overlay.style.display = 'flex';
    overlay.style.justifyContent = 'center';
    overlay.style.alignItems = 'center';

    const popup = document.createElement('div');
    popup.className = 'st-settings-popup';
    popup.style.backgroundColor = '#2a2a2a';
    popup.style.padding = '20px';
    popup.style.borderRadius = '10px';
    popup.style.maxWidth = '400px';
    popup.style.width = '100%';
    popup.style.maxHeight = '80vh';
    popup.style.overflowY = 'auto';
    
    // 标题
    const title = document.createElement('h3');
    title.textContent = '截图设置';
    title.style.marginTop = '0';
    title.style.marginBottom = '15px';
    title.style.textAlign = 'center';
    popup.appendChild(title);
    
    // 创建设置项
    const settingsConfig = [
        { id: 'screenshotDelay', type: 'number', label: '截图前延迟 (ms)', min: 0, max: 2000, step: 50 },
        { id: 'scrollDelay', type: 'number', label: 'UI更新等待 (ms)', min: 0, max: 2000, step: 50 },
        { id: 'screenshotScale', type: 'number', label: '渲染比例 (Scale)', min: 0.5, max: 4.0, step: 0.1 },
        { id: 'useForeignObjectRendering', type: 'checkbox', label: '尝试快速模式 (兼容性低)' },
        { id: 'autoInstallButtons', type: 'checkbox', label: '自动安装消息按钮' },
        { id: 'altButtonLocation', type: 'checkbox', label: '按钮备用位置' },
        { id: 'letterRendering', type: 'checkbox', label: '字形渲染' },
        { id: 'debugOverlay', type: 'checkbox', label: '显示调试覆盖层' }
    ];
    
    // 创建设置控件
    settingsConfig.forEach(setting => {
        const settingContainer = document.createElement('div');
        settingContainer.style.margin = '10px 0';
        settingContainer.style.display = 'flex';
        settingContainer.style.justifyContent = 'space-between';
        settingContainer.style.alignItems = 'center';
        
        const label = document.createElement('label');
        label.textContent = setting.label;
        label.style.marginRight = '10px';
        settingContainer.appendChild(label);
        
        let input;
        if (setting.type === 'checkbox') {
            input = document.createElement('input');
            input.type = 'checkbox';
            input.id = `st_setting_${setting.id}`;
            input.checked = settings[setting.id];
        } else if (setting.type === 'number') {
            input = document.createElement('input');
            input.type = 'number';
            input.id = `st_setting_${setting.id}`;
            input.min = setting.min;
            input.max = setting.max;
            input.step = setting.step;
            input.value = settings[setting.id];
            input.style.width = '80px';
        }
        
        settingContainer.appendChild(input);
        popup.appendChild(settingContainer);
    });
    
    // 添加保存按钮
    const buttonContainer = document.createElement('div');
    buttonContainer.style.display = 'flex';
    buttonContainer.style.justifyContent = 'center';
    buttonContainer.style.marginTop = '20px';
    
    const saveButton = document.createElement('button');
    saveButton.textContent = '保存设置';
    saveButton.style.padding = '8px 16px';
    saveButton.style.borderRadius = '4px';
    saveButton.style.backgroundColor = '#4dabf7';
    saveButton.style.border = 'none';
    saveButton.style.color = 'white';
    saveButton.style.cursor = 'pointer';
    
    saveButton.addEventListener('click', () => {
        // 保存设置
        const settings = getPluginSettings();
        
        settingsConfig.forEach(setting => {
            const input = document.getElementById(`st_setting_${setting.id}`);
            if (setting.type === 'checkbox') {
                settings[setting.id] = input.checked;
            } else if (setting.type === 'number') {
                settings[setting.id] = parseFloat(input.value);
                if (isNaN(settings[setting.id])) {
                    settings[setting.id] = defaultSettings[setting.id];
                }
            }
        });
        
        saveSettingsDebounced(); // 持久化设置
        loadConfig(); // 重新加载配置
        
        // 显示保存成功消息
        const statusMsg = document.createElement('div');
        statusMsg.textContent = '设置已保存！';
        statusMsg.style.color = '#4cb944';
        statusMsg.style.textAlign = 'center';
        statusMsg.style.marginTop = '10px';
        buttonContainer.appendChild(statusMsg);
        
        // 3秒后关闭弹窗
        setTimeout(() => {
            document.body.removeChild(overlay);
            
            // 如果设置了自动安装按钮，重新安装
            if (settings.autoInstallButtons) {
                // 先移除所有已有按钮
                document.querySelectorAll(`.${config.buttonClass}`).forEach(btn => btn.remove());
                // 重新安装
                installScreenshotButtons();
            } else {
                // 如果禁用自动安装，移除所有已安装的按钮
                document.querySelectorAll(`.${config.buttonClass}`).forEach(btn => btn.remove());
            }
        }, 1500);
    });
    
    buttonContainer.appendChild(saveButton);
    popup.appendChild(buttonContainer);
    
    overlay.appendChild(popup);
    document.body.appendChild(overlay);
    
    // 点击空白区域关闭弹窗
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) document.body.removeChild(overlay);
    });
}
