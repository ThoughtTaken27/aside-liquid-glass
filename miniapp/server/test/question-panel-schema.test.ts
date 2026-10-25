import {describe,expect,it} from 'vitest';
import {parseQuestionMarker,questionsFromToolCall} from '../src/questions.js';
describe('question panel metadata',()=>{
 it('preserves multiple choice and custom row metadata without changing answerability',()=>{
  const parsed=questionsFromToolCall('ask_user_question',{questions:[{header:'Checks',question:'Which checks?',multiple:true,allowOther:false,otherLabel:'Another check',options:[{label:'Phone',description:''}]}]});
  expect(parsed?.questions[0]).toMatchObject({multiple:true,allowOther:false,otherLabel:'Another check'});
 });
 it('keeps legacy payloads shape-compatible',()=>{
  const parsed=questionsFromToolCall('ask_user_question',{questions:[{question:'Which?',options:[]}]});expect(parsed?.questions[0]).toEqual({header:'Question',question:'Which?',options:[]});
 });
 it('supports the same fields in array and bare soft markers',()=>{
  const a=parseQuestionMarker('[[QUESTION]]'+JSON.stringify({questions:[{question:'Which?',multiple:true,options:[]}]})+'[[/QUESTION]]');
  const b=parseQuestionMarker('[[QUESTION]]'+JSON.stringify({question:'Which?',multiple:true,allowOther:false,options:[]})+'[[/QUESTION]]');
  expect(a?.questions[0].multiple).toBe(true);expect(b?.questions[0]).toMatchObject({multiple:true,allowOther:false});
 });
});
