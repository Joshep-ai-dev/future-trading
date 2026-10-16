import {TabBar,type TabItem} from '../shared/ui/ui';

export type Page='strategy'|'results'|'paper'|'account';
const pages:readonly TabItem<Page>[]=[
  {value:'paper',label:'Trading',controls:'page-paper'},
  {value:'results',label:'Backtest',controls:'page-results'},
  {value:'strategy',label:'Bot settings',controls:'page-strategy'},
  {value:'account',label:'Account',controls:'page-account'},
];

export default function Tabs({value,onChange}:{value:Page;onChange:(page:Page)=>void}){
  return <TabBar items={pages} value={value} onChange={onChange} label="Main workspace" idPrefix="tab" className="page-tabs"/>;
}
