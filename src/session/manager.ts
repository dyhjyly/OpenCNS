import {
    Session
} from "./types.js";

import {
    workingMemory
} from "../working-memory/index.js";

import {
    summarizeConversation
} from "../conversation/index.js";
import {
    routeConversation
} from "../router/index.js";


class SessionManager {


    private sessions:
    Session[] = [];



    async create(){

        const session: Session = {

            id:
            crypto.randomUUID(),

            createdAt:
            new Date().toISOString(),

            lastActiveAt:
            new Date().toISOString(),

            status:
            "active"

        };


        this.sessions.push(session);


        return session;

    }




    async get(
        id:string
    ){

        return this.sessions.find(
            session =>
            session.id === id
        );

    }




    async updateActive(
        id:string
    ){

        const session =
        await this.get(id);


        if(session){

            session.lastActiveAt =
            new Date().toISOString();

        }


        return session;

    }




    async close(
        id:string
    ){

        const session =
        await this.get(id);


        if(!session){

            return null;

        }



        const items =
        await workingMemory.list(id);



        const summary =
        await summarizeConversation(
          items,
            id
         );


        session.status =
        "closed";



        return {

            session,

            summary

        };

    }



        async closeAndStore(
        id:string
    ){

        const result =
        await this.close(id);



        if(!result){

            return null;

        }



        const memory =
        await routeConversation(
            result.summary
        );



        return {

            session:
            result.session,


            summary:
            result.summary,


            memory

        };

    }

}


export const sessionManager =
new SessionManager();