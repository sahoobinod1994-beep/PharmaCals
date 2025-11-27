
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { CalculationResult } from './types';
import { generateAnalysis } from './services/geminiService';
import { InfoTooltip } from './components/InfoTooltip';
import { Calculator, Activity, Sparkles, RefreshCw, FileText, Mic, MicOff, Volume2, ArrowRightLeft, X } from 'lucide-react';
import { GoogleGenAI, LiveServerMessage, Modality, Type, FunctionDeclaration, LiveSession } from "@google/genai";

const App: React.FC = () => {
  const [mrpInput, setMrpInput] = useState<string>('100');
  const [calculationMode, setCalculationMode] = useState<'original' | 'new'>('original');
  const [results, setResults] = useState<CalculationResult | null>(null);
  const [aiAnalysis, setAiAnalysis] = useState<string>('');
  const [isLoadingAi, setIsLoadingAi] = useState<boolean>(false);

  // Live API State
  const [isLiveActive, setIsLiveActive] = useState(false);
  const [isAiSpeaking, setIsAiSpeaking] = useState(false);
  const audioContextRef = useRef<AudioContext | null>(null);
  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const sessionRef = useRef<LiveSession | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());

  // Core Calculation Logic
  const calculate = useCallback((amount: number, mode: 'original' | 'new') => {
    const processRow = (val: number, reductionPercent: number, label: string) => {
      let originalMrp: number;
      let newMrp: number;

      if (mode === 'original') {
        // Input is Original MRP
        originalMrp = val;
        newMrp = val * (1 - (reductionPercent / 100));
      } else {
        // Input is New MRP
        newMrp = val;
        // Reverse calculation: Original = New / (1 - rate)
        originalMrp = val / (1 - (reductionPercent / 100));
      }

      const intermediatePrice = newMrp * (100 / 105);
      const finalTradePrice = intermediatePrice * 0.80;
      const gstAmount = finalTradePrice * 0.05;

      return {
        id: label,
        label,
        reductionPercent,
        inputMrp: originalMrp, // We stick to 'inputMrp' field name in type as 'Original MRP' for display consistency
        newMrp,
        intermediateTradePrice: intermediatePrice,
        finalTradePrice,
        gstAmount
      };
    };

    const row12 = processRow(amount, 6.25, "12% GST Rule");
    const row18 = processRow(amount, 11.02, "18% GST Rule");

    setResults({ row12, row18 });
    setAiAnalysis(''); 
  }, []);

  useEffect(() => {
    const num = parseFloat(mrpInput);
    if (!isNaN(num) && num > 0) {
      calculate(num, calculationMode);
    } else {
      setResults(null);
    }
  }, [mrpInput, calculationMode, calculate]);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    // Allow empty string or valid decimal numbers (digits + optional one dot)
    if (value === '' || /^\d*\.?\d*$/.test(value)) {
      setMrpInput(value);
    }
  };

  const handleAiAnalysis = async () => {
    if (!results || !process.env.API_KEY) return;
    setIsLoadingAi(true);
    // Note: We might want to pass the mode to analysis too, but the results object has the computed values
    const analysis = await generateAnalysis(results, parseFloat(mrpInput));
    setAiAnalysis(analysis);
    setIsLoadingAi(false);
  };

  // --- Live API Helpers ---

  const stopAudio = () => {
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(track => track.stop());
      mediaStreamRef.current = null;
    }
    if (inputAudioContextRef.current) {
      inputAudioContextRef.current.close();
      inputAudioContextRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    if (sessionRef.current) {
      sessionRef.current.close();
      sessionRef.current = null;
    }
    sourcesRef.current.forEach(source => source.stop());
    sourcesRef.current.clear();
    setIsLiveActive(false);
    setIsAiSpeaking(false);
  };

  const decodeAudioData = async (
    data: Uint8Array,
    ctx: AudioContext,
    sampleRate: number,
    numChannels: number,
  ): Promise<AudioBuffer> => {
    const dataInt16 = new Int16Array(data.buffer);
    const frameCount = dataInt16.length / numChannels;
    const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);

    for (let channel = 0; channel < numChannels; channel++) {
      const channelData = buffer.getChannelData(channel);
      for (let i = 0; i < frameCount; i++) {
        channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
      }
    }
    return buffer;
  };

  const base64ToUint8Array = (base64: string) => {
    const binaryString = atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
  };

  const arrayBufferToBase64 = (buffer: ArrayBuffer) => {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  };

  const toggleLive = async () => {
    if (isLiveActive) {
      stopAudio();
      return;
    }

    if (!process.env.API_KEY) {
      alert("API Key is missing.");
      return;
    }

    try {
      setIsLiveActive(true);
      
      // Setup Audio Contexts
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      const inputCtx = new AudioContextClass({ sampleRate: 16000 });
      const outputCtx = new AudioContextClass({ sampleRate: 24000 });
      inputAudioContextRef.current = inputCtx;
      audioContextRef.current = outputCtx;
      nextStartTimeRef.current = outputCtx.currentTime;

      // Setup Gemini Client
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      
      const updateMrpTool: FunctionDeclaration = {
        name: 'updateMrp',
        parameters: {
          type: Type.OBJECT,
          description: 'Update the value in the calculator',
          properties: {
            amount: {
              type: Type.NUMBER,
              description: 'The new amount to set',
            },
          },
          required: ['amount'],
        },
      };

      const switchModeTool: FunctionDeclaration = {
        name: 'switchMode',
        parameters: {
          type: Type.OBJECT,
          description: 'Switch the calculation mode between Original MRP and New MRP',
          properties: {
            mode: {
              type: Type.STRING,
              description: "The mode to switch to. Must be either 'original' or 'new'.",
            },
          },
          required: ['mode'],
        },
      };

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        callbacks: {
          onopen: () => {
            console.log('Live session connected');
            // Start recording
            const source = inputCtx.createMediaStreamSource(stream);
            const processor = inputCtx.createScriptProcessor(4096, 1, 1);
            
            processor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              // Downsample/Convert to PCM 16-bit
              const l = inputData.length;
              const pcmData = new Int16Array(l);
              for (let i = 0; i < l; i++) {
                pcmData[i] = inputData[i] * 32768;
              }
              
              const base64Data = arrayBufferToBase64(pcmData.buffer);
              
              sessionPromise.then(session => {
                session.sendRealtimeInput({
                  media: {
                    mimeType: 'audio/pcm;rate=16000',
                    data: base64Data
                  }
                });
              });
            };
            
            source.connect(processor);
            processor.connect(inputCtx.destination);
          },
          onmessage: async (msg: LiveServerMessage) => {
            // Handle Tool Calls
            if (msg.toolCall) {
              for (const fc of msg.toolCall.functionCalls) {
                if (fc.name === 'updateMrp') {
                  const newAmount = (fc.args as any).amount;
                  setMrpInput(newAmount.toString());
                  
                  sessionPromise.then(session => {
                    session.sendToolResponse({
                      functionResponses: {
                        id: fc.id,
                        name: fc.name,
                        response: { result: "ok, updated value" }
                      }
                    });
                  });
                } else if (fc.name === 'switchMode') {
                  const mode = (fc.args as any).mode;
                  if (mode === 'original' || mode === 'new') {
                    setCalculationMode(mode);
                    sessionPromise.then(session => {
                      session.sendToolResponse({
                        functionResponses: {
                          id: fc.id,
                          name: fc.name,
                          response: { result: `switched to ${mode} mode` }
                        }
                      });
                    });
                  }
                }
              }
            }

            // Handle Audio Output
            const audioData = msg.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (audioData && audioContextRef.current) {
              setIsAiSpeaking(true);
              const ctx = audioContextRef.current;
              const buffer = await decodeAudioData(
                base64ToUint8Array(audioData),
                ctx,
                24000,
                1
              );
              
              const source = ctx.createBufferSource();
              source.buffer = buffer;
              source.connect(ctx.destination);
              
              // Schedule playback
              const now = ctx.currentTime;
              const startTime = Math.max(now, nextStartTimeRef.current);
              source.start(startTime);
              nextStartTimeRef.current = startTime + buffer.duration;
              
              sourcesRef.current.add(source);
              source.onended = () => {
                sourcesRef.current.delete(source);
                if (sourcesRef.current.size === 0) {
                  setIsAiSpeaking(false);
                }
              };
            }
          },
          onclose: () => {
            console.log('Live session closed');
            setIsLiveActive(false);
          },
          onerror: (err) => {
            console.error('Live session error', err);
            stopAudio();
          }
        },
        config: {
          responseModalities: [Modality.AUDIO],
          tools: [{ functionDeclarations: [updateMrpTool, switchModeTool] }],
          systemInstruction: "You are a helpful assistant for a Pharmacy GST Calculator. Users can provide an 'Original MRP' or a 'New MRP'. Use 'switchMode' to toggle between these input modes if the user asks (e.g., 'calculate by new mrp'). Use 'updateMrp' to set the numerical value. Be concise. Speak in a friendly, professional tone.",
        }
      });
      
      sessionRef.current = await sessionPromise;

    } catch (err) {
      console.error(err);
      stopAudio();
      alert("Failed to start voice session. Make sure microphone permissions are allowed.");
    }
  };


  const formatCurrency = (val: number) => {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: 'INR',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(val);
  };

  return (
    <div className="min-h-screen bg-slate-50 font-sans text-slate-800">
      {/* Navigation */}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-30">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="bg-brand-600 p-2 rounded-lg">
              <Calculator className="w-5 h-5 text-white" />
            </div>
            <span className="text-xl font-bold text-slate-900 tracking-tight">PharmaCalc <span className="text-brand-600">SaaS</span></span>
          </div>
          <div className="flex items-center gap-4">
            <button 
              onClick={toggleLive}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium border transition-all ${
                isLiveActive 
                  ? 'bg-red-50 text-red-600 border-red-200 hover:bg-red-100' 
                  : 'bg-slate-100 text-slate-600 border-slate-200 hover:bg-slate-200'
              }`}
            >
              {isLiveActive ? <MicOff className="w-3.5 h-3.5" /> : <Mic className="w-3.5 h-3.5" />}
              {isLiveActive ? 'Stop Voice' : 'Start Voice Control'}
              {isLiveActive && (
                 <span className="flex h-2 w-2 relative ml-1">
                   <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span>
                   <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500"></span>
                 </span>
              )}
            </button>
            <div className="hidden md:flex text-xs font-medium text-slate-500 bg-slate-100 px-3 py-1 rounded-full border border-slate-200">
              GST New Rules 2025
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        
        {/* Input Section */}
        <section className="mb-8">
          <div className={`bg-white rounded-2xl shadow-sm border transition-all duration-300 p-6 flex flex-col md:flex-row items-center justify-between gap-6 ${isLiveActive ? 'ring-2 ring-red-100 border-red-200' : 'border-slate-200'}`}>
            <div className="flex-1">
              <h2 className="text-2xl font-bold text-slate-900 mb-1 flex items-center gap-2">
                GST Calculator
                {isAiSpeaking && <Volume2 className="w-5 h-5 text-brand-500 animate-pulse" />}
              </h2>
              <p className="text-slate-500 text-sm">
                Enter {calculationMode === 'original' ? 'Original MRP' : 'New MRP'} manually or use Voice Control.
              </p>
            </div>
            
            <div className="w-full md:w-auto flex flex-col items-end">
              
              {/* Input Mode Toggle */}
              <div className="flex bg-slate-100 p-1 rounded-lg mb-3">
                <button
                  onClick={() => setCalculationMode('original')}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
                    calculationMode === 'original' 
                      ? 'bg-white text-brand-600 shadow-sm' 
                      : 'text-slate-500 hover:text-slate-700'
                  }`}
                >
                  Original MRP
                </button>
                <button
                  onClick={() => setCalculationMode('new')}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
                    calculationMode === 'new' 
                      ? 'bg-white text-brand-600 shadow-sm' 
                      : 'text-slate-500 hover:text-slate-700'
                  }`}
                >
                  New MRP
                </button>
              </div>

              <label htmlFor="mrp" className="text-sm font-semibold text-slate-700 mb-2 flex items-center gap-1">
                Input {calculationMode === 'original' ? 'Original MRP' : 'New MRP'}
                <InfoTooltip text={calculationMode === 'original' ? "The MRP printed on the pack before reduction" : "The final MRP after percentage reduction"} />
              </label>
              <div className="relative group w-full md:w-64">
                <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                  <span className="text-slate-400 font-medium">₹</span>
                </div>
                <input
                  type="text"
                  inputMode="decimal"
                  id="mrp"
                  value={mrpInput}
                  onChange={handleInputChange}
                  onFocus={(e) => e.target.select()}
                  autoComplete="off"
                  className="block w-full pl-10 pr-10 py-3 bg-slate-50 border border-slate-200 rounded-xl text-xl font-bold text-slate-900 focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition-all"
                  placeholder="0.00"
                />
                {mrpInput && (
                  <button
                    onClick={() => { setMrpInput(''); document.getElementById('mrp')?.focus(); }}
                    className="absolute inset-y-0 right-0 pr-3 flex items-center text-slate-400 hover:text-slate-600 focus:outline-none"
                    title="Clear input"
                  >
                    <X className="w-5 h-5" />
                  </button>
                )}
              </div>
            </div>
          </div>
        </section>

        {/* Results - 5 Column Table */}
        {results && (
          <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
            
            <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
              {/* Table Header - 5 Columns */}
              <div className="grid grid-cols-2 md:grid-cols-5 bg-slate-100 border-b border-slate-200 py-4 px-4 md:px-6 gap-2">
                <div className="col-span-2 md:col-span-1 text-xs font-bold text-slate-500 uppercase tracking-wider">Rule (GST %)</div>
                <div className="hidden md:block text-xs font-bold text-slate-500 uppercase tracking-wider">Original MRP</div>
                <div className="hidden md:block text-xs font-bold text-slate-500 uppercase tracking-wider text-brand-700">New MRP</div>
                <div className="hidden md:block text-xs font-bold text-slate-500 uppercase tracking-wider">Trade Price</div>
                <div className="hidden md:block text-xs font-bold text-slate-500 uppercase tracking-wider">GST (CGST)</div>
              </div>

              {/* Row 1: 12% Rule */}
              <div className="grid grid-cols-1 md:grid-cols-5 py-4 md:py-6 px-4 md:px-6 border-b border-slate-100 hover:bg-slate-50 transition-colors items-center gap-4 md:gap-2">
                {/* Col 1: Category */}
                <div className="flex items-center justify-between md:block col-span-1">
                  <div className="md:hidden text-xs font-bold text-slate-500 uppercase">Rule</div>
                  <div>
                    <span className="font-bold text-slate-800 text-sm md:text-base">12% Rule</span>
                    <div className="text-[10px] md:text-xs text-slate-400">(-6.25% Reduction)</div>
                  </div>
                </div>

                {/* Col 2: Input/Original MRP */}
                <div className="flex items-center justify-between md:block col-span-1">
                  <div className="md:hidden text-xs font-bold text-slate-500 uppercase">Original MRP</div>
                  <div className={`font-medium ${calculationMode === 'new' ? 'text-brand-700' : 'text-slate-500'}`}>
                    {formatCurrency(results.row12.inputMrp)}
                    {calculationMode === 'new' && <span className="ml-1 text-[10px] bg-brand-50 text-brand-600 px-1 rounded border border-brand-100">Derived</span>}
                  </div>
                </div>

                {/* Col 3: New MRP */}
                <div className="flex items-center justify-between md:block col-span-1 bg-brand-50/50 md:bg-transparent p-2 md:p-0 rounded">
                  <div className="md:hidden text-xs font-bold text-slate-500 uppercase">New MRP</div>
                  <div className="flex flex-col">
                    <span className={`font-bold text-base md:text-lg ${calculationMode === 'new' ? 'text-slate-900' : 'text-brand-700'}`}>
                      {formatCurrency(results.row12.newMrp)}
                    </span>
                  </div>
                </div>

                {/* Col 4: Trade Price */}
                <div className="flex items-center justify-between md:block col-span-1">
                  <div className="md:hidden text-xs font-bold text-slate-500 uppercase">Trade Price</div>
                  <div className="flex flex-col">
                    <span className="font-bold text-slate-900 text-base md:text-lg">{formatCurrency(results.row12.finalTradePrice)}</span>
                    <span className="text-[10px] text-slate-400 hidden md:inline-block">(-20% Margin)</span>
                  </div>
                </div>

                {/* Col 5: GST */}
                <div className="flex items-center justify-between md:block col-span-1">
                  <div className="md:hidden text-xs font-bold text-slate-500 uppercase">GST (CGST)</div>
                  <div className="flex flex-col">
                     <span className="font-bold text-emerald-600 text-base md:text-lg">{formatCurrency(results.row12.gstAmount)}</span>
                     <span className="text-[10px] text-slate-400 hidden md:inline-block">@ 5%</span>
                  </div>
                </div>
              </div>

              {/* Row 2: 18% Rule */}
              <div className="grid grid-cols-1 md:grid-cols-5 py-4 md:py-6 px-4 md:px-6 hover:bg-slate-50 transition-colors items-center gap-4 md:gap-2">
                {/* Col 1: Category */}
                <div className="flex items-center justify-between md:block col-span-1">
                  <div className="md:hidden text-xs font-bold text-slate-500 uppercase">Rule</div>
                  <div>
                    <span className="font-bold text-slate-800 text-sm md:text-base">18% Rule</span>
                    <div className="text-[10px] md:text-xs text-slate-400">(-11.02% Reduction)</div>
                  </div>
                </div>

                {/* Col 2: Input/Original MRP */}
                <div className="flex items-center justify-between md:block col-span-1">
                  <div className="md:hidden text-xs font-bold text-slate-500 uppercase">Original MRP</div>
                  <div className={`font-medium ${calculationMode === 'new' ? 'text-brand-700' : 'text-slate-500'}`}>
                    {formatCurrency(results.row18.inputMrp)}
                    {calculationMode === 'new' && <span className="ml-1 text-[10px] bg-brand-50 text-brand-600 px-1 rounded border border-brand-100">Derived</span>}
                  </div>
                </div>

                {/* Col 3: New MRP */}
                <div className="flex items-center justify-between md:block col-span-1 bg-brand-50/50 md:bg-transparent p-2 md:p-0 rounded">
                  <div className="md:hidden text-xs font-bold text-slate-500 uppercase">New MRP</div>
                  <div className="flex flex-col">
                    <span className={`font-bold text-base md:text-lg ${calculationMode === 'new' ? 'text-slate-900' : 'text-brand-700'}`}>
                      {formatCurrency(results.row18.newMrp)}
                    </span>
                  </div>
                </div>

                {/* Col 4: Trade Price */}
                <div className="flex items-center justify-between md:block col-span-1">
                  <div className="md:hidden text-xs font-bold text-slate-500 uppercase">Trade Price</div>
                  <div className="flex flex-col">
                    <span className="font-bold text-slate-900 text-base md:text-lg">{formatCurrency(results.row18.finalTradePrice)}</span>
                    <span className="text-[10px] text-slate-400 hidden md:inline-block">(-20% Margin)</span>
                  </div>
                </div>

                {/* Col 5: GST */}
                <div className="flex items-center justify-between md:block col-span-1">
                  <div className="md:hidden text-xs font-bold text-slate-500 uppercase">GST (CGST)</div>
                  <div className="flex flex-col">
                     <span className="font-bold text-emerald-600 text-base md:text-lg">{formatCurrency(results.row18.gstAmount)}</span>
                     <span className="text-[10px] text-slate-400 hidden md:inline-block">@ 5%</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Formula Explanation Section */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
               <div className="bg-white border border-slate-200 rounded-lg p-4 text-xs text-slate-600">
                  <div className="font-semibold text-slate-800 mb-2 flex items-center gap-2">
                    <FileText className="w-3 h-3" /> 12% Calculation Details
                  </div>
                  <p>1. New MRP = {calculationMode === 'original' ? 'Original - 6.25%' : 'Input Value'}</p>
                  <p>2. Trade Price = (New MRP * 100/105) - 20%</p>
                  <p>3. GST = Trade Price * 5%</p>
               </div>
               <div className="bg-white border border-slate-200 rounded-lg p-4 text-xs text-slate-600">
                  <div className="font-semibold text-slate-800 mb-2 flex items-center gap-2">
                    <FileText className="w-3 h-3" /> 18% Calculation Details
                  </div>
                  <p>1. New MRP = {calculationMode === 'original' ? 'Original - 11.02%' : 'Input Value'}</p>
                  <p>2. Trade Price = (New MRP * 100/105) - 20%</p>
                  <p>3. GST = Trade Price * 5%</p>
               </div>
            </div>

            {/* AI Insights Section */}
            <div className="bg-slate-900 rounded-2xl shadow-lg p-6 text-white">
              <div className="flex flex-col md:flex-row items-center justify-between mb-4 gap-4">
                <div className="flex items-center gap-3 w-full">
                  <div className="bg-white/10 p-2 rounded-lg">
                    <Sparkles className="w-5 h-5 text-yellow-400" />
                  </div>
                  <div>
                    <h3 className="font-bold text-base">Profitability Analysis</h3>
                    <p className="text-slate-400 text-xs">AI-driven margin insights</p>
                  </div>
                </div>
                
                {process.env.API_KEY && (
                  <button 
                    onClick={handleAiAnalysis}
                    disabled={isLoadingAi}
                    className="w-full md:w-auto flex justify-center items-center gap-2 bg-brand-600 hover:bg-brand-500 disabled:opacity-50 text-white px-4 py-2 rounded-lg font-medium text-sm transition-all whitespace-nowrap"
                  >
                    {isLoadingAi ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Activity className="w-4 h-4" />}
                    {isLoadingAi ? 'Analyzing...' : 'Generate Report'}
                  </button>
                )}
              </div>
              
              <div className="bg-white/5 rounded-xl p-4 border border-white/10 min-h-[60px]">
                 {!process.env.API_KEY ? (
                   <p className="text-slate-400 text-sm text-center">
                     AI features require an API Key.
                   </p>
                 ) : aiAnalysis ? (
                   <p className="text-slate-200 text-sm leading-relaxed">{aiAnalysis}</p>
                 ) : (
                   <p className="text-slate-500 text-sm italic text-center">Click button to analyze trade margins.</p>
                 )}
              </div>
            </div>

          </div>
        )}
      </main>
    </div>
  );
};

export default App;
