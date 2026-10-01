export type Page = 'price'|'strategy'|'results'|'positions';
const pages: [Page,string][]=[['price','Price chart'],['strategy','Strategy settings'],['results','Results & equity'],['positions','Trade positions']];
export default function Tabs({value,onChange}:{value:Page;onChange:(page:Page)=>void}) {
  return <nav className="page-tabs" role="tablist" aria-label="Research pages">
    {pages.map(([key,label],index)=><button key={key} id={`tab-${key}`} role="tab" aria-selected={value===key} aria-controls={`page-${key}`} tabIndex={value===key?0:-1}
      onClick={()=>onChange(key)} onKeyDown={e=>{
        let next=index;
        if(e.key==='ArrowRight')next=(index+1)%pages.length;
        else if(e.key==='ArrowLeft')next=(index+pages.length-1)%pages.length;
        else if(e.key==='Home')next=0;
        else if(e.key==='End')next=pages.length-1;
        else return;
        e.preventDefault();onChange(pages[next][0]);document.getElementById(`tab-${pages[next][0]}`)?.focus();
      }}>{label}</button>)}
  </nav>;
}
