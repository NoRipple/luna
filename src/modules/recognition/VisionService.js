const llmService = require('../thinking/LLMService');

class VisionService {
    async analyzeScreen(base64Image) {
        console.log('VisionService: Analyzing screen...');
        const prompt = "请详细分析这张屏幕截图。请注意：屏幕上可能有一个二次元美少女角色（Live2D模型），请完全忽略她，专注于她背后的应用窗口和内容。请描述：1. 当前打开的窗口和应用程序名称。2. 屏幕上显示的具体内容（例如：代码段、正在编辑的文档、浏览的网页内容、观看的视频画面等）。3. 用户的活动意图（例如：正在写代码、正在看番剧、正在搜索资料、正在聊天等）。请尽可能详细和精确。";
        return await llmService.chatWithImage(base64Image, prompt);
    }
}

module.exports = new VisionService();
