export interface Session {

    id: string;

    createdAt: string;

    lastActiveAt: string;

    status:
    | "active"
    | "closed";

    summaryId?: string;

}