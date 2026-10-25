/** Synthetic QA data only. No accounts, real assignments, or external actions. */
import type { QuestionItem } from './types';
export function questionFixture(query: URLSearchParams): QuestionItem {
  const reference=query.has('reference');
  const item:QuestionItem={kind:'question',id:`question-lab-${query.toString()||'default'}`,variant:'ask',source:'marker',status:'pending',answerable:true,questions:reference?[
    {header:'Limit',question:'How much can the agent refund without asking a teammate?',options:[{label:'Never, a teammate approves every refund',description:''},{label:'Up to $50',description:''},{label:'Up to $200',description:''}],otherLabel:'A different limit'},
    {header:'Tools',question:'Which tools should it start with?',multiple:true,allowOther:false,options:['Look up orders','Issue refunds','Email the customer','Add a note to the ticket'].map(label=>({label,description:''}))},
    {header:'Uncertainty',question:'What should it do when it is not sure?',options:['Hand off to a teammate','Ask the customer a follow-up question'].map(label=>({label,description:''}))},
  ]:[
    {header:'Changes',question:'How should the agent handle a change?',options:['Ask before every change','Make small, reversible edits','Finish the requested update'].map(label=>({label,description:''}))},
    {header:'Checks',question:'Which checks should it run?',multiple:true,allowOther:false,options:['Phone layout','Keyboard controls','Dark mode','Reduced motion'].map(label=>({label,description:''}))},
    {header:'Preserve',question:'What should stay unchanged?',options:['Thinking and working status','The current expanded view'].map(label=>({label,description:''}))},
  ]};
  if(query.has('long')){item.questions[0].question='Before I change anything, which approach would you like me to use for the existing interface, including the long descriptions, narrow phone layout, and answers that need more detail?';item.questions[0].options[0].description='Keep the current behavior and explain the proposed change clearly before proceeding, including every constraint and the relevant edge cases.';item.questions[0].options[1].label='A long, unbroken example label '+ 'example'.repeat(24);}
  if(query.has('native')||query.has('readonly')){item.source='tool';item.answerable=false;}
  if(query.has('answered')){item.status='answered';item.answer='Changes: Ask before every change\nChecks: Phone layout; Keyboard controls\nPreserve: Thinking and working status';}
  return item;
}
