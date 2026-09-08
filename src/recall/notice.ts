export interface RecallNotice {
    shouldRecall: boolean;
    query: string;
    reason: string;
}


/**
 * 明确表示“想回忆”的关键词
 */
const RECALL_KEYWORDS = [
    "记得",
    "记不记得",
    "还记得",
    "想起",
    "回想",
    "回忆",
    "之前",
    "以前",
    "过去",
    "当时",
    "那次",
    "我们说过",
    "我们聊过",
    "我们决定",
    "我是不是说过",
    "我之前说过",
    "你之前说过",
    "你还记得",
    "还记得我们",
];


/**
 * 纯语气 / 寒暄 / 情绪表达
 *
 * 注意：
 * 这里不是穷举所有可能。
 * 而是判断“去掉动作、表情、标点之后，
 * 是否仍然存在实际语义”。
 */
const CASUAL_WORDS = [
    "嘿",
    "嘿嘿",
    "哈哈",
    "哈哈哈",
    "哈哈哈哈",
    "嘻嘻",
    "呵呵",
    "嗯",
    "嗯嗯",
    "哦",
    "哦哦",
    "啊",
    "啊啊",
    "呀",
    "呀呀",
    "哎",
    "诶",
    "唔",
    "呜呜",
    "好",
    "好呀",
    "好哒",
    "知道了",
    "知道啦",
    "收到",
    "行",
    "行呀",
    "可以",
    "晚安",
    "早安",
    "哈哈嘿嘿",
];


/**
 * 去除：
 * - 空白
 * - 标点
 * - emoji
 * - 常见动作描写
 * - ASCII / Unicode 表情符号
 */
function normalizeCasualText(
    text: string
): string {

    return text
        .trim()

        // 去除括号中的动作描写
        .replace(
            /（[^）]*）|\([^)]*\)/gu,
            ""
        )

        // 去除 Unicode 标点、符号、Emoji
        .replace(
            /[\s\p{P}\p{S}\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu,
            ""
        )

        // 去除常见动作描写
        .replace(
            /^(跟着笑|笑了|笑|抱住你|抱住|抱抱|蹭了蹭|蹭蹭|亲亲|亲了一下|眨眨眼|眨眼|点点头|点头|摇摇头|摇头|拍拍|摸摸|贴贴)+/g,
            ""
        )

        .trim();
}


/**
 * 判断是否属于纯轻量聊天。
 */
function isCasualMessage(
    text: string
): boolean {

    const normalized =
        normalizeCasualText(text);

    if (!normalized) {
        return true;
    }

    if (
        CASUAL_WORDS.includes(
            normalized
        )
    ) {
        return true;
    }

    /*
     * 处理：
     *
     * 嘿嘿嘿
     * 哈哈哈哈哈
     * 呜呜呜
     * 嘻嘻嘻
     *
     * 这种重复语气词。
     */
    if (
        /^(嘿|哈|嘻|呵|呜|嗯|哦|啊|呀|哎|诶|唔)+$/.test(
            normalized
        )
    ) {
        return true;
    }

    return false;
}


/**
 * 判断是否存在明确回忆意图。
 */
function containsRecallIntent(
    text: string
): boolean {

    return RECALL_KEYWORDS.some(
        keyword =>
            text.includes(keyword)
    );
}


/**
 * Notice Layer
 *
 * 负责决定：
 *
 * “这一轮有没有必要进入长期记忆 Recall？”
 *
 * 注意：
 * 这里完全机械判断。
 * 不调用 LLM。
 */
export function createRecallNotice(
    query: string
): RecallNotice {

    const text =
        query.trim();

    /*
     * 空消息
     */
    if (!text) {

        return {
            shouldRecall: false,
            query: "",
            reason: "empty-query",
        };

    }


    /*
     * 明确回忆请求
     *
     * 优先级高于 casual。
     */
    if (
        containsRecallIntent(text)
    ) {

        return {
            shouldRecall: true,
            query: text,
            reason: "explicit-recall-intent",
        };

    }


    /*
     * 纯寒暄 / 语气 / 情绪 / 动作
     */
    if (
        isCasualMessage(text)
    ) {

        return {
            shouldRecall: false,
            query: text,
            reason: "casual-message",
        };

    }


    /*
     * 目前仍然采用：
     *
     * 非纯寒暄消息 → Recall
     *
     * 后续 Memory Recall v2
     * 再进一步降低默认 Recall 范围。
     */
    return {
        shouldRecall: true,
        query: text,
        reason: "default-recall",
    };
}