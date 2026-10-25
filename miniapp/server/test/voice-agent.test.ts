import { describe, expect, it } from 'vitest';
import { classifyTask, splitReply, taskPrompt } from '../src/voice/agent.js';

describe('voice agent: which spoken requests become Aside tasks', () => {
  it.each(['research the best laptops for college', 'find me the cheapest flights to Chicago', 'compare the ProArt P16 and the Zephyrus G16', 'look into summer programs for CS'])('%s -> research', (t) => {
    expect(classifyTask(t)).toBe('research');
  });
  it.each(['book a table at Olive Garden for 7', 'fill out the volunteer form', 'can you order more printer paper', 'sign me up for the newsletter'])('%s -> act (needs fingerprint)', (t) => {
    expect(classifyTask(t)).toBe('act');
  });
  it.each(['what time is it', 'what do I need to work on today', 'tell me a joke', 'open WhatsApp'])('%s -> normal lanes', (t) => {
    expect(classifyTask(t)).toBeNull();
  });
  // Oct 6: "open YouTube Music and play ..." started a Mac task. Phone things stay on the phone.
  it.each([
    'open youtube music and play blinding lights',
    'start playing some lofi on youtube music',
    'go to spotify and play my discover weekly',
    'open instagram and show my messages',
    'download the youtube app',
    'subscribe to MKBHD',
    'play the latest MKBHD video',
    'open maps and take me home',
  ])('%s -> phone, never a Mac task', (t) => {
    expect(classifyTask(t)).toBeNull();
  });
  it.each(['go to amazon.com and order printer paper', 'open the netflix website and cancel my plan', 'download the zoom installer on my mac', 'book a table at Olive Garden for 7'])('%s -> Mac act (named a site, the Mac, or a booking)', (t) => {
    expect(classifyTask(t)).toBe('act');
  });
  it('research still works for phone-flavoured topics', () => {
    expect(classifyTask('research the best podcast apps')).toBe('research');
  });
});

describe('voice agent: prompt and reply shape', () => {
  it('quotes the request and states limits outside it', () => {
    const p = taskPrompt('act', 'book "a" table');
    expect(p).toMatch(/stop BEFORE any final step/);
    expect(p).toContain("Request: “book 'a' table”");
  });
  it('splits the spoken part from the detail', () => {
    expect(splitReply('The **G16** is $1,899 at Best Buy.\n---\nDetails here\nhttps://x.example')).toEqual({ say: 'The G16 is $1,899 at Best Buy.', detail: 'Details here\nhttps://x.example' });
    expect(splitReply('Just one line.')).toEqual({ say: 'Just one line.', detail: null });
    expect(splitReply(null)).toEqual({ say: null, detail: null });
  });
});

import { coarseLocation } from '../src/voice/devices.js';
describe('voice weather location', () => {
  it('rounds to 0.1° and rejects junk', () => {
    expect(coarseLocation({ lat: 36.0331, lon: -86.7829 })).toEqual({ lat: 36, lon: -86.8 });
    expect(coarseLocation({ lat: 91, lon: 0 })).toBeNull();
    expect(coarseLocation({ lat: Number.NaN, lon: 0 })).toBeNull();
    expect(coarseLocation({ lat: '36', lon: -86 })).toBeNull();
    expect(coarseLocation(null)).toBeNull();
  });
});
