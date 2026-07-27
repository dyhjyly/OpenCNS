import {
    WorkingMemoryItem
} from "./types.js";


const buffer: WorkingMemoryItem[] = [];


export async function addWorkingMemory(
    item: WorkingMemoryItem
){

    buffer.push(item);

}


export async function getWorkingMemory(){

    return buffer;

}


export async function clearWorkingMemory(){

    buffer.length = 0;

}
