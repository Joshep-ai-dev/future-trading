import {useRef,useState} from 'react';
import Button from '@mui/material/Button';
import ClickAwayListener from '@mui/material/ClickAwayListener';
import Paper from '@mui/material/Paper';
import Popper from '@mui/material/Popper';
import {createTheme,ThemeProvider} from '@mui/material/styles';
import {DateCalendar} from '@mui/x-date-pickers/DateCalendar';
import {LocalizationProvider} from '@mui/x-date-pickers/LocalizationProvider';
import {AdapterDayjs} from '@mui/x-date-pickers/AdapterDayjs';
import dayjs from 'dayjs';

const theme=createTheme({palette:{mode:'dark',primary:{main:'#86b5ff'},background:{paper:'#19212d',default:'#10151d'},text:{primary:'#e3ecf9',secondary:'#99abc3'}},typography:{fontFamily:'Inter, Arial, sans-serif',fontSize:13},shape:{borderRadius:8}});

type Props={value:string;minimum:string;maximum:string;disabled?:boolean;onChange:(value:string)=>void};
export default function MaterialDatePicker({value,minimum,maximum,disabled=false,onChange}:Props){
  const [open,setOpen]=useState(false);
  const anchor=useRef<HTMLButtonElement>(null);
  function close(){setOpen(false);anchor.current?.focus();}
  return <ThemeProvider theme={theme}><LocalizationProvider dateAdapter={AdapterDayjs}>
    <ClickAwayListener onClickAway={()=>setOpen(false)} mouseEvent="onMouseDown" touchEvent="onTouchStart">
      <div className="material-chart-date-field">
        <Button ref={anchor} type="button" className="material-date-trigger" aria-label="Choose chart date" aria-haspopup="dialog" aria-expanded={open} disabled={disabled} disableRipple onClick={()=>setOpen(previous=>!previous)} onKeyDown={event=>{if(event.key==='ArrowDown'){event.preventDefault();setOpen(true);}}}>{dayjs(value).format('MM/DD/YYYY')}</Button>
        <Popper open={open} anchorEl={anchor.current} placement="bottom-end" modifiers={[{name:'offset',options:{offset:[0,8]}},{name:'preventOverflow',options:{padding:8}}]} sx={{zIndex:1500}}>
          <Paper elevation={12} role="dialog" aria-label="Choose chart date" className="material-chart-calendar" onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close();}}} sx={{overflow:'hidden',bgcolor:'background.paper',borderRadius:2}}>
            <DateCalendar value={dayjs(value)} minDate={dayjs(minimum)} maxDate={dayjs(maximum)} disabled={disabled} showDaysOutsideCurrentMonth onChange={selected=>{if(selected?.isValid()){onChange(selected.format('YYYY-MM-DD'));close();}}} sx={{width:300,maxWidth:'calc(100vw - 16px)',height:320,'& .MuiPickersCalendarHeader-root':{marginTop:1.5},'& .MuiPickersDay-root':{fontSize:12}}}/>
          </Paper>
        </Popper>
      </div>
    </ClickAwayListener>
  </LocalizationProvider></ThemeProvider>;
}
