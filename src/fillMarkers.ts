import type {SeriesMarker,UTCTimestamp,IPrimitivePaneRenderer,ISeriesPrimitive,SeriesAttachedParameter,Time} from 'lightweight-charts';

export const FILL_COLORS={buy:'#38d9ff',sell:'#ffb347'};

/** Preserve execution details for the chart readout and marker selection. */
export function fillMarker(time:number,price:number,_label:string,kind:'entry'|'close',direction:number,id:string,quantity:number):SeriesMarker<UTCTimestamp> {
  const buy=kind==='entry'?direction===1:direction!==1;
  const name=kind==='entry'?(direction===1?'Long':'Short'):`Close ${direction===1?'long':'short'}`;
  return {
    time:time as UTCTimestamp,position:buy?'atPriceBottom':'atPriceTop',price,
    shape:buy?'arrowUp':'arrowDown',
    color:buy?FILL_COLORS.buy:FILL_COLORS.sell,
    id,text:`${name}\n${buy?'+':'-'}${Number(quantity.toFixed(3))}\n@ ${Number(price.toFixed(8))}`,size:1,
  };
}

/** Canvas labels stay attached to fill coordinates while panning, zooming and replaying. */
export class FillLabels implements ISeriesPrimitive<Time> {
  private attachedTo:SeriesAttachedParameter<Time>|null=null;
  private markers:SeriesMarker<UTCTimestamp>[]=[];
  private candles:{time:number;high:number;low:number}[]=[];
  private renderer:IPrimitivePaneRenderer={draw:target=>{
    const attached=this.attachedTo;
    if(!attached)return;
    target.useMediaCoordinateSpace(({context:ctx,mediaSize})=>{
      ctx.save();
      ctx.font='600 11px sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';
      const candles=this.candles.flatMap(c=>{
        const x=attached.chart.timeScale().timeToCoordinate(c.time as UTCTimestamp);
        const high=attached.series.priceToCoordinate(c.high),low=attached.series.priceToCoordinate(c.low);
        return x===null||high===null||low===null||x<0||x>mediaSize.width?[]:[{x,top:Math.min(high,low),bottom:Math.max(high,low)}];
      });
      const occupied:{left:number;right:number;top:number;bottom:number}[]=[];
      for(const marker of this.markers){
        if(marker.price===undefined)continue;
        const x=attached.chart.timeScale().timeToCoordinate(marker.time),y=attached.series.priceToCoordinate(marker.price);
        if(x===null||y===null||x<0||x>mediaSize.width||y<0||y>mediaSize.height)continue;
        // The small point is the fill; the arrow and label sit clear of nearby wicks.
        ctx.fillStyle=marker.color;ctx.strokeStyle='#080c13';ctx.lineWidth=2;
        ctx.beginPath();ctx.arc(x,y,3.5,0,Math.PI*2);ctx.fill();ctx.stroke();
        const below=marker.shape==='arrowUp',lines=(marker.text??'').split('\n').slice(0,2);
        const width=Math.max(...lines.map(line=>ctx.measureText(line).width))+12;
        const labelX=Math.max(width/2+4,Math.min(mediaSize.width-width/2-4,x));
        const left=labelX-width/2,right=labelX+width/2;
        const nearby=candles.filter(c=>c.x>=left-8&&c.x<=right+8);
        let tip=below?Math.max(y,...nearby.map(c=>c.bottom))+10:Math.min(y,...nearby.map(c=>c.top))-10;
        let top=below?tip:tip-48,bottom=top+48;
        // Stack neighboring trade labels instead of drawing text on top of text.
        for(let i=0;i<=occupied.length;i++){
          const hit=occupied.find(r=>left<r.right+6&&right>r.left-6&&top<r.bottom+6&&bottom>r.top-6);
          if(!hit)break;
          top=below?hit.bottom+6:hit.top-54;bottom=top+48;tip=below?top:bottom;
        }
        // At dense zoom levels retain exact fill points; details remain in the readout.
        if(top<4||bottom>mediaSize.height-4)continue;
        occupied.push({left,right,top,bottom});
        ctx.strokeStyle=marker.color;ctx.globalAlpha=.8;ctx.lineWidth=1;
        ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(labelX,tip);ctx.stroke();ctx.globalAlpha=1;
        const tail=tip+(below?16:-16);
        ctx.lineWidth=2.5;ctx.beginPath();ctx.moveTo(labelX,tail);ctx.lineTo(labelX,tip);ctx.stroke();
        ctx.beginPath();ctx.moveTo(labelX,tip);ctx.lineTo(labelX-4,tip+(below?6:-6));ctx.lineTo(labelX+4,tip+(below?6:-6));ctx.closePath();ctx.fill();
        const start=below?tip+27:tip-39;
        // A small opaque backing keeps indicator lines from cutting through the text.
        ctx.fillStyle='#080c13';ctx.fillRect(left,start-7,width,28);
        ctx.strokeStyle=marker.color;ctx.lineWidth=1;ctx.strokeRect(left,start-7,width,28);
        lines.forEach((line,index)=>{ctx.fillStyle=index===1?marker.color:'#ffffff';ctx.fillText(line,labelX,start+index*14);});
      }
      ctx.restore();
    });
  }};
  private view={renderer:()=>this.renderer};
  attached(parameters:SeriesAttachedParameter<Time>){this.attachedTo=parameters;}
  detached(){this.attachedTo=null;}
  paneViews(){return [this.view];}
  setMarkers(markers:SeriesMarker<UTCTimestamp>[],candles:{time:number;high:number;low:number}[]){this.markers=markers.filter(m=>m.price!==undefined);this.candles=candles;this.attachedTo?.requestUpdate();}
}
