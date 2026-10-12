export function formatUtc8(
    value: string | number | Date | null | undefined
): string {
    if (value == null || value === "") {
        return "时间未知";
    }

    const date = value instanceof Date
        ? value
        : new Date(value);

    if (Number.isNaN(date.getTime())) {
        return String(value);
    }

    const formatted = new Intl.DateTimeFormat("sv-SE", {
        timeZone: "Asia/Shanghai",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
    }).format(date);

    return `${formatted} UTC+8`;
}
