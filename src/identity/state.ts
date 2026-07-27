import {
    IdentityState
} from "./types.js";



let state:
IdentityState | null = null;



export function getIdentityState(){

    return state;

}



export function updateIdentityState(
    next: IdentityState
){

    state = next;

    return state;

}
