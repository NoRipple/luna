const OpenAI = require('openai');

class LLMService {
    constructor() {
        this.client = new OpenAI({
            apiKey: 'sk-4cd47b2fdb4a48c0ac31b731072c4ba0',
            baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1'
        });
    }

    /**
     * Text Interaction Service
     * @param {string} prompt - The user's input text
     * @param {function} onChunk - Callback for streaming chunks (optional)
     * @returns {Promise<string>} - The full response text
     */
    async chatWithText(prompt, onChunk = null) {
        try {
            const completion = await this.client.chat.completions.create({
                model: "deepseek-v3.2",
                messages: [{ role: "user", content: prompt }],
                stream: true,
                extra_body: { enable_thinking: true }
            });

            let fullContent = '';
            let reasoningContent = '';

            for await (const chunk of completion) {
                const delta = chunk.choices[0]?.delta;
                
                if (delta?.reasoning_content) {
                    reasoningContent += delta.reasoning_content;
                    if (onChunk) onChunk({ type: 'reasoning', content: delta.reasoning_content });
                }
                
                if (delta?.content) {
                    fullContent += delta.content;
                    if (onChunk) onChunk({ type: 'content', content: delta.content });
                }
            }

            return fullContent;
        } catch (error) {
            console.error('Error in chatWithText:', error);
            throw error;
        }
    }

    /**
     * Image Interaction Service
     * @param {string} imageUrl - URL of the image or Base64 string (data:image/jpeg;base64,...)
     * @param {string} prompt - The question about the image
     * @param {function} onChunk - Callback for streaming chunks (optional)
     * @returns {Promise<string>} - The full response text
     */
    async chatWithImage(imageUrl, prompt = "Describe this image", onChunk = null) {
        try {
            const completion = await this.client.chat.completions.create({
                model: "qwen3-vl-plus",
                messages: [
                    {
                        role: "user",
                        content: [
                            {
                                type: "image_url",
                                image_url: { url: imageUrl }
                            },
                            { type: "text", text: prompt }
                        ]
                    }
                ],
                stream: true,
                extra_body: { 
                    enable_thinking: true,
                    thinking_budget: 81920
                }
            });

            let fullContent = '';
            let reasoningContent = '';

            for await (const chunk of completion) {
                const delta = chunk.choices[0]?.delta;
                
                if (delta?.reasoning_content) {
                    reasoningContent += delta.reasoning_content;
                    if (onChunk) onChunk({ type: 'reasoning', content: delta.reasoning_content });
                }
                
                if (delta?.content) {
                    fullContent += delta.content;
                    if (onChunk) onChunk({ type: 'content', content: delta.content });
                }
            }

            return fullContent;
        } catch (error) {
            console.error('Error in chatWithImage:', error);
            throw error;
        }
    }

    /**
     * Companion Chat Service (Chain: Analysis -> Response)
     * @param {string} analysis - The analysis of what user is doing
     * @returns {Promise<object>} - JSON response { text, action, expression }
     */
    async chatWithCompanion(analysis) {
        const prompt = `
你是一位知性、温柔、成熟的少女伙伴，生活在用户的电脑桌面上。
你总是用优雅、平和的语调说话，善解人意，能够敏锐地察觉用户的情绪和状态。
当前情况：用户正在做以下事情：“${analysis}”。

任务：
1. 对用户的行为做出反应。说话要知性、温柔，充满关怀。
2. 对用户的称呼必须是“你”，禁止使用“主人”或其他称呼。
3. 必须使用中文回复。
4. 选择一个合适的 Live2D 动作（例如 "Tap", "Idle", "TapBody", "TapHead", "Shake", "Tapface", "Taphair", "Tapxiongbu", "Tapqunzi", "Tapleg"）和表情（例如 "exp1.exp3" 到 "exp7.exp3"）。
5. 仅输出一个 JSON 对象。不要输出 Markdown 代码块。

JSON 格式示例：
{
  "text": "工作这么久了，要不要稍微停下来休息一下？我很担心你的眼睛呢。",
  "motion": "TapHead",
  "expression": "exp1.exp3"
}
`;
        try {
            // We use chatWithText but without streaming for simplicity here, 
            // or we can just parse the final result.
            const responseText = await this.chatWithText(prompt);
            
            // Try to extract JSON from response (in case model wraps it in markdown)
            let jsonStr = responseText.trim();
            if (jsonStr.startsWith('```json')) {
                jsonStr = jsonStr.replace(/^```json/, '').replace(/```$/, '');
            } else if (jsonStr.startsWith('```')) {
                jsonStr = jsonStr.replace(/^```/, '').replace(/```$/, '');
            }
            
            return JSON.parse(jsonStr);
        } catch (error) {
            console.error('Error in chatWithCompanion:', error);
            return { 
                text: "Hmm... something went wrong...", 
                motion: "Idle", 
                expression: "exp3" 
            };
        }
    }
}

module.exports = new LLMService();
