"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.success = success;
exports.failure = failure;
function success(data) {
    return {
        content: [
            {
                type: 'text',
                text: JSON.stringify(data, null, 2),
            },
        ],
    };
}
function failure(error) {
    return {
        content: [
            {
                type: 'text',
                text: JSON.stringify({
                    success: false,
                    error,
                }, null, 2),
            },
        ],
    };
}
//# sourceMappingURL=utils.js.map