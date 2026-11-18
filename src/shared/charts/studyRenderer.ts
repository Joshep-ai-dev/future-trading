import {LineSeries,LineStyle,type AutoscaleInfo,type IChartApi,type ISeriesApi,type UTCTimestamp} from 'lightweight-charts';
import {BollingerOverlay} from './BollingerOverlay';
import {chartBollingerBands} from './bollingerBands';
import {SupertrendOverlay} from './SupertrendOverlay';
import {chartSupertrend} from './supertrend';
import {chartTripleMa,TRIPLE_MA_OPACITY,tripleMaColors} from './tripleMa';
import {chartOscillators} from './chartOscillators';
import {indicatorColor} from './indicatorColors';
import {AdxVisualizer,adxColor,adxLevels,diColors,levelColor} from './adxDisplay';
import {PaneBand} from './PaneBand';
import {alpha,type IndicatorConfig,type IndicatorKind} from './IndicatorSettings';
import {isPaneStudy,type ChartStudy} from './chartStudies';
import type {LegendOverlay,StudyValue} from './ChartLegend';
import {TV} from './tvTheme';

type Bar={time:number;open:number;high:number;low:number;close:number};
/** all: every loaded candle; current: up to the indicator clock (overlays); completed: closed candles (panes). */
export type StudyInput={all:Bar[];current:Bar[];completed:Bar[];duration:number};
export type PaneValue={value:number|null;extra?:{value:number|null;color:string}[]};
type Values=Map<number,Record<string,StudyValue[]>>;
type Item={
  study:ChartStudy;
  paint:(input:StudyInput,add:(time:number,values:StudyValue[])=>void)=>void;
  setVisible:(visible:boolean)=>void;
  dispose:()=>void;
  pane?:ISeriesApi<'Line'>;
  valueAt?:(time:number|null)=>PaneValue;
};
const t=(time:number)=>time as UTCTimestamp;
const width=(value:number)=>value as 1|2|3|4;

/** Draws a list of indicator instances (several of the same kind allowed) on one chart. */
export class StudyRenderer{
  private items:Item[]=[];
  private structure='';
  constructor(private chart:IChartApi,private price:ISeriesApi<'Candlestick'>){}

  /** Returns true when series/panes were rebuilt (caller should repaint and re-measure panes). */
  setStudies(studies:readonly ChartStudy[]):boolean{
    const structure=JSON.stringify(studies.map(study=>[study.id,study.kind,study.config]));
    if(structure===this.structure){
      for(const item of this.items){const study=studies.find(next=>next.id===item.study.id);if(study){item.study=study;item.setVisible(!study.hidden);}}
      return false;
    }
    this.structure=structure;
    this.clear();
    this.items=studies.map(study=>this.create(study));
    for(const item of this.items)item.setVisible(!item.study.hidden);
    this.chart.panes().forEach((pane,index)=>pane.setStretchFactor(index===0?3:1));
    return true;
  }

  paint(input:StudyInput):Values{
    const values:Values=new Map();
    for(const item of this.items){
      const key=item.study.id;
      item.paint(input,(time,row)=>{const entry=values.get(time)??{};entry[key]=row;values.set(time,entry);});
    }
    return values;
  }

  paneValues(time:number|null):Record<string,PaneValue>{
    const result:Record<string,PaneValue>={};
    for(const item of this.items)if(item.valueAt)result[item.study.id]=item.valueAt(time);
    return result;
  }

  panes():{id:string;series:ISeriesApi<'Line'>}[]{
    return this.items.flatMap(item=>item.pane?[{id:item.study.id,series:item.pane}]:[]);
  }

  dispose(){this.clear();this.structure='';}

  private clear(){for(const item of this.items)item.dispose();this.items=[];}

  private line(color:string,lineWidth:number,pane=0,extra:Record<string,unknown>={}){
    return this.chart.addSeries(LineSeries,{color,lineWidth:width(lineWidth),title:'',priceLineVisible:false,...extra},pane);
  }

  private create(study:ChartStudy):Item{
    const config=study.config;
    if(study.kind==='ma'){
      const series=this.line(config.trendSmaColor,config.trendSmaWidth,0,{lastValueVisible:false,crosshairMarkerVisible:false});
      return {study,
        paint:({all},add)=>{
          const length=config.trendSmaLength;let sum=0;
          series.setData(all.map((c,index)=>{
            sum+=c.close;if(index>=length)sum-=all[index-length].close;
            if(index+1<length)return {time:t(c.time)};
            const value=sum/length;add(c.time,[{text:value.toFixed(3),color:config.trendSmaColor}]);
            return {time:t(c.time),value};
          }));
        },
        setVisible:visible=>series.applyOptions({visible}),
        dispose:()=>this.chart.removeSeries(series)};
    }
    if(study.kind==='triplema'){
      const colors=tripleMaColors(config);
      const lines=colors.map(color=>this.line(alpha(color,TRIPLE_MA_OPACITY),config.maWidth,0,{lastValueVisible:true,crosshairMarkerVisible:false,priceFormat:{type:'price',precision:3,minMove:.001}}));
      return {study,
        paint:({current},add)=>{
          const averages=chartTripleMa(current,[config.maFast,config.maMid,config.maSlow],config.maType);
          lines.forEach((series,index)=>series.setData(averages.map(point=>point.values[index]===null?{time:t(point.time)}:{time:t(point.time),value:point.values[index]!})));
          for(const point of averages)add(point.time,point.values.map((value,index)=>({text:value===null?'∅':value.toFixed(3),color:colors[index]})));
        },
        setVisible:visible=>lines.forEach(series=>series.applyOptions({visible})),
        dispose:()=>lines.forEach(series=>this.chart.removeSeries(series))};
    }
    if(study.kind==='bollinger'){
      const overlay=new BollingerOverlay();this.price.attachPrimitive(overlay);
      overlay.setStyle({basis:config.bbBasisColor,upper:config.bbUpperColor,lower:config.bbLowerColor,width:config.bbWidth});
      return {study,
        paint:({current},add)=>{
          const bands=chartBollingerBands(current,{length:config.bbLength,maType:config.bbMaType,source:config.bbSource,multiplier:config.bbMultiplier,offset:config.bbOffset});
          overlay.setData(bands,config.bbOffset);
          for(const point of bands)if(point.basis!==null)add(point.time,[
            {text:point.basis.toFixed(3),color:config.bbBasisColor},
            {text:point.upper!.toFixed(3),color:config.bbUpperColor},
            {text:point.lower!.toFixed(3),color:config.bbLowerColor},
          ]);
        },
        setVisible:visible=>overlay.setVisible(visible),
        dispose:()=>this.price.detachPrimitive(overlay)};
    }
    if(study.kind==='supertrend'){
      const overlay=new SupertrendOverlay();this.price.attachPrimitive(overlay);
      overlay.setStyle({up:config.stUpColor,down:config.stDownColor,width:config.stWidth});
      return {study,
        paint:({current,duration},add)=>{
          const trend=chartSupertrend(current,duration,config.supertrendLength,config.supertrendMultiplier);
          overlay.setData(trend);
          for(const point of trend)if(point.value!==null)add(point.time,[{text:point.value.toFixed(3),color:point.direction==='down'?config.stDownColor:config.stUpColor}]);
        },
        setVisible:visible=>overlay.setVisible(visible),
        dispose:()=>this.price.detachPrimitive(overlay)};
    }
    return this.createPane(study,study.kind as IndicatorKind);
  }

  private createPane(study:ChartStudy,kind:IndicatorKind):Item{
    const config=study.config;
    const series=this.line(kind==='adx'?adxColor(null,config):kind==='atr'?config.atrColor:config.rsiColor,kind==='adx'?config.adxWidth:kind==='atr'?config.atrWidth:config.rsiWidth,this.chart.panes().length,
      {priceFormat:{type:'price',precision:kind==='atr'?3:2,minMove:kind==='atr'?.001:.01}});
    series.priceScale().applyOptions({scaleMargins:kind==='rsi'?{top:.04,bottom:.04}:{top:.12,bottom:.08}});
    const paneIndex=series.getPane().paneIndex();
    let di:ISeriesApi<'Line'>[]=[],adx:AdxVisualizer|null=null,band:PaneBand|null=null;
    if(kind==='adx'){
      if(config.showAdxLevels)for(const value of adxLevels(config))
        series.createPriceLine({price:value,color:levelColor(value,config),lineWidth:1,lineStyle:LineStyle.Dotted,axisLabelVisible:true,title:''});
      di=[config.diPlusColor,config.diMinusColor].map(color=>this.line(color,1,paneIndex,{lastValueVisible:config.showDi,crosshairMarkerVisible:config.showDi,visible:config.showDi,priceFormat:{type:'price',precision:2,minMove:.01}}));
      adx=new AdxVisualizer(config.showStatus,config);series.attachPrimitive(adx);
    }
    if(kind==='atr'){
      series.createPriceLine({price:config.atrThreshold,color:TV.orange,title:'',lineStyle:LineStyle.Dashed,lineWidth:1,axisLabelVisible:false});
      series.applyOptions({autoscaleInfoProvider:(original:()=>AutoscaleInfo|null)=>{
        const info=original();
        return info?.priceRange?{...info,priceRange:{minValue:Math.min(info.priceRange.minValue,config.atrThreshold),maxValue:Math.max(info.priceRange.maxValue,config.atrThreshold)}}:null;
      }});
    }
    if(kind==='rsi'){
      series.applyOptions({autoscaleInfoProvider:()=>({priceRange:{minValue:0,maxValue:100},margins:{above:2,below:2}})});
      band=new PaneBand(config.rsiLower,config.rsiUpper,'rgba(126,87,194,0.1)');series.attachPrimitive(band);
      for(const [value,color,style] of [[config.rsiUpper,TV.muted,LineStyle.Dashed],[50,'rgba(156,156,156,0.5)',LineStyle.Dotted],[config.rsiLower,TV.muted,LineStyle.Dashed]] as const)
        series.createPriceLine({price:value,color,title:'',lineStyle:style,lineWidth:1,axisLabelVisible:false});
    }
    let data:ReturnType<typeof chartOscillators>=[],key='';
    const byTime=new Map<number,(typeof data)[number]>();
    return {study,pane:series,
      paint:({completed,duration})=>{
        const last=completed.at(-1);
        const next=`${completed.length}:${completed[0]?.time}:${last?.time}:${last?.open}:${last?.high}:${last?.low}:${last?.close}`;
        if(next===key)return;
        key=next;
        data=chartOscillators(completed,duration,config.atrLength,config.adxLength,config.atrSmoothing,config.rsiLength,config.diLength);
        byTime.clear();for(const point of data)byTime.set(point.time,point);
        series.setData(data.map(p=>p[kind]===null?{time:t(p.time)}:{time:t(p.time),value:p[kind]!,color:kind==='adx'?adxColor(p.adx,config):indicatorColor(kind,p[kind],config)}));
        if(kind==='adx'){
          (['pdi','mdi'] as const).forEach((field,index)=>di[index]?.setData(data.map(p=>p[field]===null?{time:t(p.time)}:{time:t(p.time),value:p[field]!})));
          adx?.setData(data);
        }
      },
      valueAt:time=>{
        const point=(time===null?undefined:byTime.get(time))??data.at(-1);
        const value=point?.[kind]??null;
        return kind==='adx'&&config.showDi
          ?{value,extra:[{value:point?.pdi??null,color:diColors(config).plus},{value:point?.mdi??null,color:diColors(config).minus}]}
          :{value};
      },
      setVisible:visible=>{
        series.applyOptions({visible});
        adx?.setVisible(visible);band?.setVisible(visible);
        for(const line of di)line.applyOptions({visible:visible&&config.showDi});
      },
      dispose:()=>{for(const line of di)this.chart.removeSeries(line);this.chart.removeSeries(series);}};
  }
}

/** Legend rows for price-pane studies, one per instance (keyed by instance id). */
export function studyLegends(studies:readonly ChartStudy[],actions:{onSettings:(id:string)=>void;onToggleHidden:(id:string)=>void;onRemove:(id:string)=>void}):LegendOverlay[]{
  return studies.filter(study=>!isPaneStudy(study.kind)).map(study=>{
    const c:IndicatorConfig=study.config;
    const [name,params,color]=study.kind==='ma'?['MA',String(c.trendSmaLength),c.trendSmaColor]
      :study.kind==='triplema'?['Triple MA',`${c.maFast} ${c.maMid} ${c.maSlow}${c.maType==='EMA'?' EMA':''}`,c.maFastColor]
      :study.kind==='bollinger'?['BB',`${c.bbLength} ${c.bbMaType} ${c.bbSource} ${c.bbMultiplier}${c.bbOffset?` ${c.bbOffset}`:''}`,c.bbBasisColor]
      :['Supertrend',`${c.supertrendLength} ${c.supertrendMultiplier}`,c.stUpColor];
    return {key:study.id,name,params,color,hidden:study.hidden,
      onToggleVisible:()=>actions.onToggleHidden(study.id),
      onSettings:()=>actions.onSettings(study.id),
      onRemove:()=>actions.onRemove(study.id)};
  });
}
