import {createContext,type Dispatch,type SetStateAction} from 'react';

export type ExecutionMode='manual'|'bot';
export const ExecutionModeContext=createContext<[ExecutionMode,Dispatch<SetStateAction<ExecutionMode>>]|null>(null);

export const LiveSidebarContext=createContext<{open:boolean;toggle:()=>void}|null>(null);
