'use strict';
const $ = id => document.getElementById(id);
const presets = [
  {id:'small1',name:'Small 1-inch',w:22,h:32}, {id:'one',name:'1-inch',w:25,h:35},
  {id:'large1',name:'Large 1-inch',w:33,h:48}, {id:'small2',name:'Small 2-inch',w:33,h:48},
  {id:'two',name:'2-inch',w:35,h:49}, {id:'large2',name:'Large 2-inch',w:35,h:53}
];
const state = {preset:'one',name:'1-inch',w:25,h:35,unit:'mm',dpi:300,original:false,format:'image/jpeg',image:null,
  work:document.createElement('canvas'),cx:0,cy:0,zoom:1,rotation:0,flip:false,face:null,grid:true,
  history:[],revision:0,fileToken:0,fileName:'sample-portrait.jpg',demo:true};
const editor = $('editorCanvas'), ctx = editor.getContext('2d');
const preview = $('previewCanvas'), pctx = preview.getContext('2d');
const maxPreviewEdge = 2560;
const maxPreviewPixels = 3_200_000;
const maxEditorPixels = 4_000_000;
const zoomSlider = $('zoom'), zoomValue = $('zoomValue'), outputSize = $('outputSize');
const resolutionNote = $('resolutionNote'), resolutionIcon = $('resolutionIcon'), resolutionText = $('resolutionText');
let frame = {x:0,y:0,w:0,h:0}, stageW=0,stageH=0, scheduled=false, toastTimer;
let modelPromise, busy=false, zoomStart=null, dragStart=null, pointers=new Map(), pinchStart=null;
let modelState = 'idle', fitRequest = 0;
const smartButton = $('smartBtn'), smartStatusText = $('smartStatus').lastElementChild;
const loadingFaces = 'Loading face detection…';
const lookingForFaces = 'Looking for faces…';
const facesUnavailable = 'Face detection is unavailable. You can adjust the crop manually.';

function toast(message){$('toast').textContent=message;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,3600)}
function status(message,warning=false){smartStatusText.textContent=message;$('smartStatus').classList.toggle('warning',warning)}
function clearFaceProgress() {
  if (![loadingFaces, lookingForFaces].includes(smartStatusText.textContent)) return;
  const message = modelState === 'ready' ? 'Face detection is ready.'
    : modelState === 'unavailable' ? facesUnavailable : 'Auto-frame photo to detect faces.';
  status(message, modelState === 'unavailable');
}
function afterEditorPaint() {
  return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}
function snapshot(){return {cx:state.cx,cy:state.cy,zoom:state.zoom,rotation:state.rotation,flip:state.flip,face:state.face?{...state.face}:null}}
function remember(s=snapshot()){state.history.push(s);if(state.history.length>30)state.history.shift();updateUndo()}
function updateUndo(){$('undoBtn').disabled=!state.history.length}
function touch(){state.revision++}
function dimensions(){
  if(state.original&&state.image&&frame.w>0){
    const turned=Math.abs(state.rotation)%180===90,scale=minScale()*state.zoom;
    const sourceW=turned?state.image.naturalHeight:state.image.naturalWidth;
    const sourceH=turned?state.image.naturalWidth:state.image.naturalHeight;
    return {w:Math.max(1,Math.round(frame.w/scale*sourceW/state.work.width)),h:Math.max(1,Math.round(frame.h/scale*sourceH/state.work.height))};
  }
  if(state.unit==='mm')return {w:Math.max(1,Math.round(state.w/25.4*state.dpi)),h:Math.max(1,Math.round(state.h/25.4*state.dpi))};
  if(state.unit==='px')return {w:state.w,h:state.h};
  const scale=1200/Math.max(state.w,state.h);return {w:Math.max(1,Math.round(state.w*scale)),h:Math.max(1,Math.round(state.h*scale))};
}
function calcFrame(){
  const r=state.w/state.h;
  const side = Math.min(28, stageW * .055);
  const top = Math.min(82, Math.max(58, stageH * .12));
  const availableHeight = stageH - top - 16;
  const h = Math.min(availableHeight, (stageW - side * 2) / r), w = h * r;
  frame = {x:(stageW-w)/2,y:top+(availableHeight-h)/2,w,h};
}
function minScale(){return Math.max(frame.w/state.work.width,frame.h/state.work.height)}
function clamp(){
  if(!state.image||!frame.w)return;
  state.zoom=Math.max(1,Math.min(5,state.zoom));
  const scale=minScale()*state.zoom;
  const hx=frame.w/scale/2,hy=frame.h/scale/2;
  state.cx=Math.max(hx,Math.min(state.work.width-hx,state.cx));
  state.cy=Math.max(hy,Math.min(state.work.height-hy,state.cy));
}
function requestRender(){if(!scheduled){scheduled=true;requestAnimationFrame(()=>{scheduled=false;render()})}}
function updateUI(){
  document.querySelectorAll('.preset').forEach(b=>{const active=b.dataset.id===state.preset;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));b.querySelector('.selected-tick').style.display=active?'':'none'});
  const sizeText=state.unit==='ratio'?`${state.w} : ${state.h}`:`${state.w} × ${state.h} ${state.unit}`;
  $('stageSize').textContent=`${state.name} · ${sizeText}`;
  $('previewName').textContent=state.preset?`${state.name} ID photo`:'Custom crop';
  $('previewPhysical').textContent=sizeText;
  const d=dimensions();outputSize.textContent=`${d.w} × ${d.h} px`;
  $('dpi').title=state.unit==='px'?'Original pixels keeps the source resolution within the crop. A DPI setting uses the entered pixel dimensions.':'';
  requestRender();
}
function render(){
  calcFrame();ctx.clearRect(0,0,stageW,stageH);
  if(!state.image)return;
  clamp();const s=minScale()*state.zoom;
  const x=frame.x+frame.w/2-state.cx*s,y=frame.y+frame.h/2-state.cy*s;
  // Draw only the source pixels that are visible on the stage, even at high zoom.
  const left = Math.max(0, -x / s), top = Math.max(0, -y / s);
  const width = Math.min(state.work.width, (stageW - x) / s) - left;
  const height = Math.min(state.work.height, (stageH - y) / s) - top;
  ctx.drawImage(state.work, left, top, width, height, x + left * s, y + top * s, width * s, height * s);
  ctx.save();ctx.fillStyle='rgba(226,232,218,.80)';ctx.beginPath();ctx.rect(0,0,stageW,stageH);ctx.rect(frame.x,frame.y,frame.w,frame.h);ctx.fill('evenodd');ctx.restore();
  ctx.strokeStyle='#1c392a35';ctx.lineWidth=4;ctx.strokeRect(frame.x,frame.y,frame.w,frame.h);
  ctx.strokeStyle='#fff';ctx.lineWidth=2;ctx.strokeRect(frame.x,frame.y,frame.w,frame.h);
  if(state.grid){
    ctx.save();ctx.beginPath();ctx.rect(frame.x,frame.y,frame.w,frame.h);ctx.clip();ctx.lineWidth=.7;ctx.strokeStyle='rgba(255,255,255,.48)';ctx.setLineDash([4,4]);
    for(let i=1;i<3;i++){ctx.beginPath();ctx.moveTo(frame.x+frame.w*i/3,frame.y);ctx.lineTo(frame.x+frame.w*i/3,frame.y+frame.h);ctx.moveTo(frame.x,frame.y+frame.h*i/3);ctx.lineTo(frame.x+frame.w,frame.y+frame.h*i/3);ctx.stroke()}
    ctx.restore();
  }
  ctx.strokeStyle='#2d7350';ctx.lineWidth=3;ctx.lineCap='square';
  const l=14;for(const [cx,cy,dx,dy] of [[frame.x,frame.y,1,1],[frame.x+frame.w,frame.y,-1,1],[frame.x,frame.y+frame.h,1,-1],[frame.x+frame.w,frame.y+frame.h,-1,-1]]){ctx.beginPath();ctx.moveTo(cx,cy+dy*l);ctx.lineTo(cx,cy);ctx.lineTo(cx+dx*l,cy);ctx.stroke()}
  const zoomPercent = String(Math.round(state.zoom * 100));
  if (zoomSlider.value !== zoomPercent) zoomSlider.value = zoomPercent;
  if (zoomValue.value !== `${zoomPercent}%`) zoomValue.value = `${zoomPercent}%`;
  const d=dimensions(), pscale=Math.min(1,500/Math.max(d.w,d.h));
  const sizeText = `${d.w} × ${d.h} px`;
  if (outputSize.textContent !== sizeText) outputSize.textContent = sizeText;
  const pw=Math.max(1,Math.round(d.w*pscale)),ph=Math.max(1,Math.round(d.h*pscale));
  if(preview.width!==pw||preview.height!==ph){preview.width=pw;preview.height=ph}
  drawCrop(pctx,pw,ph);
  const turned=Math.abs(state.rotation)%180===90;
  const availableW=frame.w/s*(turned?state.image.naturalHeight:state.image.naturalWidth)/state.work.width;
  const availableH=frame.h/s*(turned?state.image.naturalWidth:state.image.naturalHeight)/state.work.height;
  const upscale=d.w>availableW*1.1||d.h>availableH*1.1;
  const message = state.original ? 'Keeps the source resolution'
    : upscale ? 'Export will enlarge the source crop'
    : state.unit === 'mm' ? 'Sized for print' : 'Exports at the selected size';
  if (resolutionText.textContent !== message) resolutionText.textContent = message;
  const icon = upscale ? '#i-info' : '#i-check';
  if (resolutionIcon.getAttribute('href') !== icon) resolutionIcon.setAttribute('href', icon);
  resolutionNote.classList.toggle('warning', upscale);
}
function drawCrop(context,w,h,fromOriginal=false){
  const scale=minScale()*state.zoom,sw=frame.w/scale,sh=frame.h/scale;
  context.fillStyle='#ffffff';context.fillRect(0,0,w,h);context.imageSmoothingQuality=fromOriginal?'high':'medium';
  if(fromOriginal){
    // Apply the editor's crop and transforms directly to the decoded original.
    const turned=Math.abs(state.rotation)%180===90;
    const sourceW=turned?state.work.height:state.work.width,sourceH=turned?state.work.width:state.work.height;
    context.save();context.scale(w/sw,h/sh);context.translate(sw/2-state.cx,sh/2-state.cy);
    context.translate(state.work.width/2,state.work.height/2);context.scale(state.flip?-1:1,1);context.rotate(state.rotation*Math.PI/180);
    context.drawImage(state.image,-sourceW/2,-sourceH/2,sourceW,sourceH);context.restore();
  }else context.drawImage(state.work,state.cx-sw/2,state.cy-sh/2,sw,sh,0,0,w,h);
}
function resize(){
  const rect=$('stage').getBoundingClientRect();stageW=rect.width;stageH=rect.height;
  const dpr = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(maxEditorPixels / (stageW * stageH)));
  const width = Math.floor(stageW * dpr), height = Math.floor(stageH * dpr);
  if (editor.width !== width) editor.width = width;
  if (editor.height !== height) editor.height = height;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingQuality = 'medium';
  calcFrame();
  requestRender();
}
function rebuild(){
  const img=state.image;if(!img)return;
  const sc = Math.min(1, maxPreviewEdge / Math.max(img.naturalWidth, img.naturalHeight),
    Math.sqrt(maxPreviewPixels / (img.naturalWidth * img.naturalHeight)));
  const w = Math.max(1, Math.floor(img.naturalWidth * sc));
  const h = Math.max(1, Math.floor(img.naturalHeight * sc));
  const turned = Math.abs(state.rotation) % 180 === 90;
  state.work.width=turned?h:w;state.work.height=turned?w:h;
  const c=state.work.getContext('2d');c.imageSmoothingQuality='high';c.translate(state.work.width/2,state.work.height/2);c.scale(state.flip?-1:1,1);c.rotate(state.rotation*Math.PI/180);c.drawImage(img,-w/2,-h/2,w,h);
}
function centerFit(){state.cx=state.work.width/2;state.cy=state.work.height/2;state.zoom=1;clamp();requestRender()}
function faceFit(){
  if(!state.face){centerFit();return}
  const f=state.face,r=state.w/state.h;
  const cropH=Math.min(f.height/.38,state.work.height,state.work.width/r);
  state.zoom=(frame.h/cropH)/minScale();
  state.cx=f.x+f.width/2;state.cy=f.y+f.height/2;
  clamp();requestRender();
}
async function detectFace(){
  // Face detection uses a smaller copy of the already resized editing image.
  const input=document.createElement('canvas'),s=Math.min(1,1000/Math.max(state.work.width,state.work.height));
  input.width=Math.round(state.work.width*s);input.height=Math.round(state.work.height*s);input.getContext('2d').drawImage(state.work,0,0,input.width,input.height);
  const faces=await faceapi.detectAllFaces(input,new faceapi.TinyFaceDetectorOptions({inputSize:416,scoreThreshold:.3}));
  if(!faces.length)return {face:null,count:0};
  faces.sort((a,b)=>b.box.width*b.box.height-a.box.width*a.box.height);
  const b=faces[0].box;return {face:{x:b.x/s,y:b.y/s,width:b.width/s,height:b.height/s},count:faces.length};
}
async function smartFit({save=true}={}) {
  if (busy || !state.image) return;
  if (save) remember();
  const request = ++fitRequest, revision = ++state.revision, token = state.fileToken;
  const isCurrent = () => revision === state.revision && token === state.fileToken;
  smartButton.disabled = true;

  try {
    let result = { face: state.face, count: 1 };
    if (!result.face) {
      if (modelState === 'unavailable') {
        status(facesUnavailable, true);
        return;
      }
      const needsModel = modelState !== 'ready';
      status(needsModel ? loadingFaces : lookingForFaces);
      // Give the editor and its status a frame to paint before model work starts.
      await afterEditorPaint();
      if (!isCurrent()) return;
      const ready = await ensureFaceModel();
      if (!isCurrent()) return;
      if (!ready) {
        status(facesUnavailable, true);
        return;
      }
      if (needsModel) {
        status(lookingForFaces);
        await afterEditorPaint();
        if (!isCurrent()) return;
      }
      result = await detectFace();
      if (!isCurrent()) return;
    }

    if (result.face) {
      state.face = result.face;
      faceFit();
      status(result.count > 1 ? 'Crop centered on the largest face.' : 'Crop centered on the detected face.');
    } else {
      status('No face found. You can adjust the crop manually.', true);
    }
  } catch (error) {
    if (isCurrent()) status(facesUnavailable, true);
    console.warn('Face detection unavailable:', error.message);
  } finally {
    if (request === fitRequest) {
      smartButton.disabled = busy || !state.image;
      if (!isCurrent() && !busy) clearFaceProgress();
    }
  }
}
function changeSize(w,h,unit,name,preset){
  touch();state.w=w;state.h=h;state.unit=unit;state.name=name;state.preset=preset;state.history=[];updateUndo();calcFrame();updateUI();
  if(state.image){centerFit();smartFit({save:false})}
}
async function loadImage(src,name,isDemo=false){
  const token=++state.fileToken;touch();$('loadOverlay').hidden=false;busy=true;
  smartButton.disabled = true;
  let loaded = false;
  try{
    const img=new Image();img.src=src;await img.decode();if(token!==state.fileToken)return;
    if(img.naturalWidth<10||img.naturalHeight<10){toast('Choose a photo at least 10 px wide and 10 px tall.');return}
    state.image=img;state.fileName=name;state.demo=isDemo;state.rotation=0;state.flip=false;state.face=null;state.history=[];updateUndo();rebuild();
    $('fileName').textContent=name;$('fileMeta').textContent=`${img.naturalWidth} × ${img.naturalHeight} px`;
    centerFit();$('downloadBtn').disabled=false;
    loaded = true;
  }catch(e){if(token===state.fileToken)toast('Could not open this photo. Choose a valid JPG, PNG, or WebP file.')}
  finally {
    if (token === state.fileToken) {
      $('loadOverlay').hidden = true;
      busy = false;
      smartButton.disabled = !state.image;
      if (!loaded && state.image) clearFaceProgress();
    }
    if (src.startsWith('blob:')) URL.revokeObjectURL(src);
  }
  if (loaded && token === state.fileToken) smartFit({save:false});
}
function acceptFile(file){
  if(!file)return;
  if(!['image/jpeg','image/png','image/webp'].includes(file.type)){toast('Choose a JPG, PNG, or WebP photo.');return}
  if(file.size>30*1024*1024){toast('This photo exceeds 30 MB. Choose a smaller file.');return}
  loadImage(URL.createObjectURL(file),file.name);
}
function setZoom(value,anchor=null){
  if(!state.image)return;
  touch();const old=minScale()*state.zoom;state.zoom=Math.max(1,Math.min(5,value));const next=minScale()*state.zoom;
  if(anchor){state.cx+=(anchor.x-frame.x-frame.w/2)*(1/old-1/next);state.cy+=(anchor.y-frame.y-frame.h/2)*(1/old-1/next)}
  clamp();requestRender();
}
function point(e){const rect=editor.getBoundingClientRect();return {x:e.clientX-rect.left,y:e.clientY-rect.top}}
function distance(a,b){return Math.hypot(a.x-b.x,a.y-b.y)}
editor.addEventListener('pointerdown',e=>{
  if(!state.image||busy)return;
  e.preventDefault();editor.focus({preventScroll:true});editor.setPointerCapture(e.pointerId);const p=point(e);pointers.set(e.pointerId,p);
  if(pointers.size===1){remember();touch();dragStart={p,cx:state.cx,cy:state.cy}}
  if(pointers.size===2){const [a,b]=[...pointers.values()];pinchStart={distance:distance(a,b),zoom:state.zoom};dragStart=null}
});
editor.addEventListener('pointermove',e=>{
  if(!pointers.has(e.pointerId))return;const p=point(e);pointers.set(e.pointerId,p);
  if(pointers.size===2&&pinchStart){const [a,b]=[...pointers.values()];setZoom(pinchStart.zoom*distance(a,b)/Math.max(1,pinchStart.distance))}
  else if(dragStart){const s=minScale()*state.zoom;state.cx=dragStart.cx-(p.x-dragStart.p.x)/s;state.cy=dragStart.cy-(p.y-dragStart.p.y)/s;clamp();requestRender()}
});
function endPointer(e){pointers.delete(e.pointerId);pinchStart=null;if(pointers.size===1){const p=[...pointers.values()][0];dragStart={p,cx:state.cx,cy:state.cy}}else dragStart=null}
editor.addEventListener('pointerup',endPointer);editor.addEventListener('pointercancel',endPointer);
let wheelTimer,wheelActive=false;
editor.addEventListener('wheel',e=>{if(!state.image)return;e.preventDefault();if(!wheelActive){remember();wheelActive=true}clearTimeout(wheelTimer);wheelTimer=setTimeout(()=>wheelActive=false,200);setZoom(state.zoom*Math.exp(-e.deltaY*.0015),point(e))},{passive:false});
editor.addEventListener('keydown',e=>{
  if((e.ctrlKey||e.metaKey)&&e.key==='z'){e.preventDefault();undo();return}
  if(!state.image||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key))return;
  e.preventDefault();if(!e.repeat)remember();touch();const delta=(e.shiftKey?10:1)/(minScale()*state.zoom);
  if(e.key==='ArrowLeft')state.cx+=delta;if(e.key==='ArrowRight')state.cx-=delta;if(e.key==='ArrowUp')state.cy+=delta;if(e.key==='ArrowDown')state.cy-=delta;
  clamp();requestRender();
});
function undo(){const saved=state.history.pop();if(!saved)return;touch();Object.assign(state,saved);rebuild();clamp();updateUndo();requestRender();status('Last adjustment undone.')}
$('undoBtn').addEventListener('click',undo);
$('zoom').addEventListener('pointerdown',()=>{if(state.image){zoomStart=snapshot();remember(zoomStart)}});
$('zoom').addEventListener('keydown',e=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(e.key)&&!e.repeat)remember()});
$('zoom').addEventListener('input',e=>setZoom(Number(e.target.value)/100));
$('zoomIn').addEventListener('click',()=>{remember();setZoom(state.zoom+.1)});$('zoomOut').addEventListener('click',()=>{remember();setZoom(state.zoom-.1)});
$('rotateBtn').addEventListener('click',()=>{if(!state.image)return;remember();touch();state.rotation=(state.rotation-90)%360;state.face=null;rebuild();centerFit();status('Rotated left 90°. Use Auto-frame to center the face again.')});
$('flipBtn').addEventListener('click',()=>{if(!state.image)return;remember();touch();state.flip=!state.flip;state.cx=state.work.width-state.cx;if(state.face)state.face.x=state.work.width-state.face.x-state.face.width;rebuild();requestRender()});
$('resetBtn').addEventListener('click',()=>{if(!state.image)return;remember();touch();state.rotation=0;state.flip=false;state.face=null;rebuild();centerFit();smartFit({save:false});toast('Crop reset.')});
$('gridBtn').addEventListener('click',()=>{state.grid=!state.grid;$('gridBtn').classList.toggle('active',state.grid);$('gridBtn').setAttribute('aria-pressed',String(state.grid));requestRender()});
$('smartBtn').addEventListener('click',()=>smartFit());
$('presets').innerHTML=presets.map(p=>`<button class="preset" data-id="${p.id}" aria-pressed="false"><span><strong>${p.name.replace('-', '‑')}</strong><small>${p.w} × ${p.h} mm</small></span><svg class="selected-tick"><use href="#i-check"/></svg></button>`).join('');
$('presets').addEventListener('click',e=>{const btn=e.target.closest('[data-id]');if(!btn)return;const p=presets.find(p=>p.id===btn.dataset.id);changeSize(p.w,p.h,'mm',p.name,p.id)});
function tab(custom){$('presetTab').classList.toggle('active',!custom);$('customTab').classList.toggle('active',custom);$('presetTab').setAttribute('aria-selected',String(!custom));$('customTab').setAttribute('aria-selected',String(custom));$('presetPanel').hidden=custom;$('customPanel').hidden=!custom}
$('presetTab').addEventListener('click',()=>tab(false));$('customTab').addEventListener('click',()=>tab(true));
$('unit').addEventListener('change',()=>{const unit=$('unit').value;$('customWidth').value=unit==='px'?600:unit==='ratio'?3:25;$('customHeight').value=unit==='px'?800:unit==='ratio'?4:35;const max=unit==='px'?10000:1000;for(const id of ['customWidth','customHeight']){$(id).max=max;$(id).step=unit==='mm'?.1:1}});
$('ratios').addEventListener('click',e=>{const btn=e.target.closest('[data-ratio]');if(!btn)return;const [w,h]=btn.dataset.ratio.split(',');$('unit').value='ratio';$('customWidth').value=w;$('customHeight').value=h;$('applyCustom').click()});
function showSizeError(message) {
  $('customError').textContent = message;
  $('sizeErrorDialog').showModal();
}

$('applyCustom').addEventListener('click',()=>{
  const w=Number($('customWidth').value),h=Number($('customHeight').value),unit=$('unit').value,max=unit==='px'?10000:1000;
  if (!Number.isFinite(w) || !Number.isFinite(h) || w < 1 || h < 1 || w > max || h > max || (unit !== 'mm' && (!Number.isInteger(w) || !Number.isInteger(h)))) {
    showSizeError(unit === 'mm' ? `Enter dimensions from 1 to ${max} mm.` : `Enter whole numbers from 1 to ${max}.`);
    return;
  }
  if (w / h < .1 || w / h > 10) {
    showSizeError('Enter an aspect ratio between 1:10 and 10:1.');
    return;
  }
  const ow=unit==='mm'?w/25.4*state.dpi:w,oh=unit==='mm'?h/25.4*state.dpi:h;
  if (!state.original && unit !== 'ratio' && (ow * oh > 40e6 || ow > 12000 || oh > 12000)) {
    showSizeError('Exports are limited to 40 megapixels and 12,000 px per side.');
    return;
  }
  changeSize(w,h,unit,'Custom',null)
});
$('dpi').addEventListener('change',()=>{
  if($('dpi').value==='original'){state.original=true;updateUI();return}
  const dpi=Number($('dpi').value),w=state.w/25.4*dpi,h=state.h/25.4*dpi;
  if(state.unit==='mm'&&(w*h>40e6||w>12000||h>12000)){$('dpi').value=state.original?'original':state.dpi;toast('This size is too large at that DPI. Lower the DPI or reduce the dimensions.');return}
  state.original=false;state.dpi=dpi;updateUI();
});
document.querySelectorAll('[data-format]').forEach(btn=>btn.addEventListener('click',()=>{state.format=btn.dataset.format;document.querySelectorAll('[data-format]').forEach(b=>{const active=b===btn;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active))})}));
$('uploadBtn').addEventListener('click',()=>$('fileInput').click());$('fileInput').addEventListener('change',e=>{acceptFile(e.target.files[0]);e.target.value=''});
let dragDepth=0;
$('stage').addEventListener('dragenter',e=>{e.preventDefault();dragDepth++;$('dropOverlay').classList.add('visible')});
$('stage').addEventListener('dragover',e=>{e.preventDefault();e.dataTransfer.dropEffect='copy'});
$('stage').addEventListener('dragleave',e=>{e.preventDefault();if(--dragDepth<=0){dragDepth=0;$('dropOverlay').classList.remove('visible')}});
$('stage').addEventListener('drop',e=>{e.preventDefault();dragDepth=0;$('dropOverlay').classList.remove('visible');acceptFile(e.dataTransfer.files[0])});
window.addEventListener('dragover',e=>e.preventDefault());window.addEventListener('drop',e=>e.preventDefault());
$('helpBtn').addEventListener('click',()=>$('helpDialog').showModal());$('closeHelp').addEventListener('click',()=>$('helpDialog').close());$('helpDialog').addEventListener('click',e=>{if(e.target===$('helpDialog')){const r=e.target.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)e.target.close()}});

// Encode physical resolution so exported files retain their selected print size.
function crc32(bytes){let c=0xffffffff;for(const b of bytes){c^=b;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0)}return(c^0xffffffff)>>>0}
async function withDpi(blob,dpi){
  const b=new Uint8Array(await blob.arrayBuffer());
  if(blob.type==='image/png'){
    const chunk=new Uint8Array(21),view=new DataView(chunk.buffer);view.setUint32(0,9);chunk.set([112,72,89,115],4);const ppm=Math.round(dpi/.0254);view.setUint32(8,ppm);view.setUint32(12,ppm);chunk[16]=1;view.setUint32(17,crc32(chunk.subarray(4,17)));
    return new Blob([b.subarray(0,33),chunk,b.subarray(33)],{type:blob.type});
  }
  // Insert a JFIF APP0 header immediately after SOI. Canvas JPEG may already carry one;
  // when present, update it rather than creating ambiguous duplicate resolution data.
  if(b[0]===255&&b[1]===216){
    for(let pos=2;pos+18<b.length&&b[pos]===255;){const marker=b[pos+1];if(marker===218||marker===217)break;const len=(b[pos+2]<<8)|b[pos+3];if(marker===224&&String.fromCharCode(...b.subarray(pos+4,pos+9))==='JFIF\0'){b[pos+11]=1;b[pos+12]=dpi>>8;b[pos+13]=dpi&255;b[pos+14]=dpi>>8;b[pos+15]=dpi&255;return new Blob([b],{type:blob.type})}if(len<2)break;pos+=len+2}
    const header=new Uint8Array([255,224,0,16,74,70,73,70,0,1,1,1,dpi>>8,dpi&255,dpi>>8,dpi&255,0,0]);return new Blob([b.subarray(0,2),header,b.subarray(2)],{type:blob.type});
  }
  return blob;
}
$('downloadBtn').addEventListener('click',async()=>{
  if(!state.image||busy)return;
  $('downloadBtn').disabled=true;
  try{
    render();const {w,h}=dimensions();if(w*h>40e6||Math.max(w,h)>12000)throw new Error('The export is too large. Reduce the dimensions.');
    const output=document.createElement('canvas');output.width=w;output.height=h;drawCrop(output.getContext('2d'),w,h,true);
    const raw=await new Promise(resolve=>output.toBlob(resolve,state.format,.96));if(!raw)throw new Error('Export failed. Reduce the dimensions and try again.');
    const exportDpi=state.original&&state.unit==='mm'?Math.max(1,Math.min(65535,Math.round(w*25.4/state.w))):state.dpi;
    const blob=await withDpi(raw,exportDpi),url=URL.createObjectURL(blob),a=document.createElement('a');
    const name=state.fileName.replace(/\.[^.]+$/,'').replace(/[\\/:*?"<>|]/g,'_');a.href=url;a.download=`${name}_${state.name}_${w}x${h}.${state.format==='image/png'?'png':'jpg'}`;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);toast(`Exported a ${w} × ${h} px photo.`);
  }catch(e){toast(e.message||'Export failed. Try smaller dimensions.')}
  finally{$('downloadBtn').disabled=false}
});

async function loadScript(src) {
  const script = document.createElement('script');
  script.src = src;
  try {
    await new Promise((resolve, reject) => {
      script.onload = resolve;
      script.onerror = () => reject(new Error('Could not load ' + src));
      document.head.append(script);
    });
  } finally {
    script.remove();
  }
}

async function loadLocalAssets() {
  // Classic scripts can load from disk without a Fetch request to a file URL.
  await loadScript('./dist/assets/local-preview.js');
  try {
    const assets = window.photoCutLocalAssets;
    if (!assets) throw new Error('The local preview assets are missing.');
    return assets;
  } finally {
    delete window.photoCutLocalAssets;
  }
}

async function loadFaceModel(localAssets) {
  await loadScript('./dist/assets/face-api.min.js');
  const detector = faceapi.nets.tinyFaceDetector;
  if (!localAssets) {
    await detector.loadFromUri('./dist/models');
    return;
  }

  const { specs, weights } = await localAssets;
  const bytes = Uint8Array.from(atob(weights), character => character.charCodeAt(0));
  detector.loadFromWeightMap(faceapi.tf.io.decodeWeights(bytes.buffer, specs));
}

const localAssets = location.protocol === 'file:' ? loadLocalAssets() : null;
function ensureFaceModel() {
  modelPromise ??= loadFaceModel(localAssets).then(
    () => { modelState = 'ready'; return true; },
    error => { modelState = 'unavailable'; console.warn(error.message); return false; }
  );
  return modelPromise;
}
new ResizeObserver(resize).observe($('stage'));
resize();updateUI();updateUndo();
if (localAssets) {
  // Keep the demo canvas readable when separate file URLs have opaque origins.
  localAssets.then(
    ({ demo }) => { if (!state.fileToken) loadImage(demo, 'sample-portrait.jpg', true); },
    () => { if (!state.fileToken) toast('Could not open the sample photo. You can still open your own photo.'); }
  );
} else {
  loadImage('./dist/assets/demo.jpg', 'sample-portrait.jpg', true);
}
