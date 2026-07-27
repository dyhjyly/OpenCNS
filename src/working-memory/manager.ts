import {
    WorkingMemoryItem,
    WorkingMemoryStore
} from "./types.js";


class MemoryManager
implements WorkingMemoryStore {


    private items:
    WorkingMemoryItem[] = [];


    async add(
        item: WorkingMemoryItem
    ) {

        this.items.push(item);


        // Working Memory v1
        // 只保留最近50条

        if(this.items.length > 50){

            this.items =
            this.items.slice(-50);

        }

    }


    async list(
        sessionId?: string
    ){

        if(!sessionId){

            return this.items;

        }


        return this.items.filter(
            item =>
            item.sessionId === sessionId
        );

    }


    async clear(
        sessionId?: string
    ){

        if(!sessionId){

            this.items=[];

            return;

        }


        this.items =
        this.items.filter(
            item =>
            item.sessionId !== sessionId
        );

    }

}


export const workingMemory =
new MemoryManager();
