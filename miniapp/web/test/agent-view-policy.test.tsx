import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useAgentView } from '../src/hooks/useAgentView';
describe('Agent view is a user choice, not a chat-opening side effect',()=>{
  it('reopened chats stay closed on first metadata, reconnects and changed targets',()=>{const{result}=renderHook(()=>useAgentView(false));expect(result.current.liveOpen).toBe(false);for(const id of ['old-tab',null,'new-tab']){act(()=>result.current.onLiveTab(id,true));expect(result.current.liveOpen).toBe(false);}act(()=>result.current.show());expect(result.current.liveOpen).toBe(true);});
  it('new conversations reveal only their first positively agent-created tab',()=>{const consumed=vi.fn(),{result}=renderHook(()=>useAgentView(true,consumed));act(()=>result.current.onLiveTab('unverified',false));expect(result.current.liveOpen).toBe(false);act(()=>result.current.onLiveTab('owned',true));expect(result.current.liveOpen).toBe(true);expect(consumed).toHaveBeenCalledTimes(1);act(()=>result.current.show(false));act(()=>result.current.onLiveTab('owned-2',true));expect(result.current.liveOpen).toBe(false);expect(consumed).toHaveBeenCalledTimes(1);});
  it('a manual choice wins even before an owned tab arrives; lost tabs close the view',()=>{const{result}=renderHook(()=>useAgentView(true));act(()=>result.current.show(false));act(()=>result.current.onLiveTab('owned',true));expect(result.current.liveOpen).toBe(false);act(()=>result.current.show(true));act(()=>result.current.onLiveTab(null));expect(result.current.liveOpen).toBe(false);});
});
