<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Tutts - Solicitar Corrida</title>
    <meta name="theme-color" content="#7c3aed">
    <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🏍️</text></svg>">
    <script src="https://cdn.tailwindcss.com"></script>
    <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
    <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
    <script src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
    <script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
    <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
    <style>
        @keyframes fadeIn { from { opacity: 0; transform: translateY(-10px); } to { opacity: 1; transform: translateY(0); } }
        .fade-in { animation: fadeIn 0.3s ease-out; }
        #mapa, #mapaAcompanhar { z-index: 1; }
        .leaflet-container { width: 100% !important; height: 100% !important; background: #e5e7eb; }
        ::-webkit-scrollbar { width: 6px; height: 6px; }
        ::-webkit-scrollbar-track { background: #f1f1f1; border-radius: 3px; }
        ::-webkit-scrollbar-thumb { background: #93c5fd; border-radius: 3px; }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
        .animate-pulse-custom { animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite; }
    </style>
</head>
<body class="bg-gray-100 min-h-screen">
    <div id="root"></div>
    
    <script type="text/babel">
        const { useState, useEffect } = React;
        const API_URL = 'https://tutts-backend-production.up.railway.app';
        const SITE_URL = 'https://www.centraltutts.online';
        
        const Toast = ({ mensagem, tipo, onClose }) => {
            useEffect(() => { const timer = setTimeout(onClose, 4000); return () => clearTimeout(timer); }, []);
            const cores = { success: 'bg-green-500', error: 'bg-red-500', warning: 'bg-yellow-500', info: 'bg-blue-500' };
            return (<div className={`fixed top-4 right-4 ${cores[tipo]} text-white px-4 py-3 rounded-lg shadow-lg z-50 fade-in max-w-sm`}>{mensagem}</div>);
        };
        
        const TelaLogin = ({ onLogin, showToast }) => {
            const [email, setEmail] = useState('');
            const [senha, setSenha] = useState('');
            const [loading, setLoading] = useState(false);
            
            const handleSubmit = async (e) => {
                e.preventDefault();
                if (!email || !senha) { showToast('Preencha email e senha', 'error'); return; }
                setLoading(true);
                try {
                    const resp = await fetch(`${API_URL}/api/solicitacao/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, senha }) });
                    const data = await resp.json();
                    if (resp.ok) { localStorage.setItem('solicitacao_token', data.token); localStorage.setItem('solicitacao_cliente', JSON.stringify(data.cliente)); showToast('Bem-vindo!', 'success'); onLogin(data.cliente, data.token); }
                    else { showToast(data.error || 'Erro', 'error'); }
                } catch (err) { showToast('Erro de conexão', 'error'); }
                setLoading(false);
            };
            
            return (
                <div className="min-h-screen bg-gradient-to-br from-blue-100 to-blue-200 flex items-center justify-center p-4">
                    <div className="bg-white rounded-2xl shadow-2xl p-8 w-full max-w-md">
                        <div className="text-center mb-6"><div className="text-6xl mb-4">🏍️</div><h1 className="text-2xl font-bold text-gray-800">Solicitar Corrida</h1></div>
                        <form onSubmit={handleSubmit} className="space-y-4">
                            <div><label className="block text-sm font-semibold text-gray-700 mb-1">Email</label><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="w-full px-4 py-3 rounded-lg border focus:ring-2 focus:ring-blue-500 outline-none" placeholder="seu@email.com" /></div>
                            <div><label className="block text-sm font-semibold text-gray-700 mb-1">Senha</label><input type="password" value={senha} onChange={(e) => setSenha(e.target.value)} className="w-full px-4 py-3 rounded-lg border focus:ring-2 focus:ring-blue-500 outline-none" placeholder="••••••••" /></div>
                            <button type="submit" disabled={loading} className="w-full py-3 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-lg disabled:opacity-50">{loading ? 'Entrando...' : 'Entrar'}</button>
                        </form>
                    </div>
                </div>
            );
        };
        
        const Solicitacao = ({ cliente, token, onLogout, showToast }) => {
            const [abaAtiva, setAbaAtiva] = useState('nova');
            const [pontos, setPontos] = useState([]);
            const [termoBusca, setTermoBusca] = useState('');
            const [sugestoes, setSugestoes] = useState([]);
            const [buscando, setBuscando] = useState(false);
            const [loading, setLoading] = useState(false);
            const [mapa, setMapa] = useState(null);
            const [markersLayer, setMarkersLayer] = useState(null);
            const [historico, setHistorico] = useState([]);
            const [mostrarHistorico, setMostrarHistorico] = useState(false);
            const [abaMobile, setAbaMobile] = useState('form');
            const [pontoEditando, setPontoEditando] = useState(null);
            const [dadosPonto, setDadosPonto] = useState({ observacao: '', telefone: '', procurar_por: '', numero_nota: '', codigo_finalizar: '' });
            const [corridasAtivas, setCorridasAtivas] = useState([]);
            const [corridaSelecionada, setCorridaSelecionada] = useState(null);
            const [detalheCorrida, setDetalheCorrida] = useState(null);
            const [mapaAcompanhar, setMapaAcompanhar] = useState(null);
            const [markersAcompanhar, setMarkersAcompanhar] = useState(null);
            const [gruposExpandidos, setGruposExpandidos] = useState({});
            
            const [profissionais, setProfissionais] = useState([]);
            const [carregandoProfissionais, setCarregandoProfissionais] = useState(false);
            
            const [config, setConfig] = useState({
                numero_pedido: '', centro_custo: cliente.centro_custo_padrao || '', usuario_solicitante: cliente.nome,
                data_retirada: '', hora_retirada: '', forma_pagamento: cliente.forma_pagamento_padrao || 'F',
                ponto_receber: '', retorno: false, obs_retorno: '', ordenar: true, 
                codigo_profissional: '',
                sem_profissional: false
            });
            
            useEffect(() => { carregarProfissionais(); }, []);
            
            const carregarProfissionais = async () => {
                setCarregandoProfissionais(true);
                try {
                    const resp = await fetch(`${API_URL}/api/solicitacao/profissionais`, { headers: { 'Authorization': `Bearer ${token}` } });
                    if (resp.ok) {
                        const data = await resp.json();
                        setProfissionais(data.profissionais || []);
                    }
                } catch (err) { console.error('Erro ao carregar profissionais:', err); }
                setCarregandoProfissionais(false);
            };
            
            useEffect(() => {
                if (typeof L !== 'undefined' && !mapa && abaAtiva === 'nova') {
                    setTimeout(() => {
                        const container = document.getElementById('mapa');
                        if (container && !container._leaflet_id) {
                            const m = L.map('mapa').setView([-16.6869, -49.2648], 12);
                            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(m);
                            setMapa(m); setMarkersLayer(L.layerGroup().addTo(m));
                            setTimeout(() => m.invalidateSize(), 100);
                        }
                    }, 100);
                }
            }, [abaAtiva]);
            
            useEffect(() => {
                if (typeof L !== 'undefined' && !mapaAcompanhar && abaAtiva === 'acompanhar' && corridaSelecionada) {
                    setTimeout(() => {
                        const container = document.getElementById('mapaAcompanhar');
                        if (container && !container._leaflet_id) {
                            const m = L.map('mapaAcompanhar').setView([-16.6869, -49.2648], 12);
                            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(m);
                            setMapaAcompanhar(m); setMarkersAcompanhar(L.layerGroup().addTo(m));
                            setTimeout(() => m.invalidateSize(), 100);
                        }
                    }, 100);
                }
            }, [abaAtiva, corridaSelecionada]);
            
            useEffect(() => { if (cliente.endereco_partida_padrao) setPontos([{ id: Date.now(), ...cliente.endereco_partida_padrao, isPartida: true }]); carregarHistorico(); carregarCorridasAtivas(); }, []);
            
            useEffect(() => {
                if (abaAtiva !== 'acompanhar') return;
                const interval = setInterval(() => { carregarCorridasAtivas(); if (corridaSelecionada) carregarDetalheCorrida(corridaSelecionada); }, 10000);
                return () => clearInterval(interval);
            }, [abaAtiva, corridaSelecionada]);
            
            useEffect(() => {
                if (mapa && markersLayer) {
                    markersLayer.clearLayers();
                    pontos.forEach((p, idx) => {
                        if (p.latitude && p.longitude) {
                            const icon = L.divIcon({ className: '', html: `<div style="background:${idx === 0 ? '#10b981' : '#3b82f6'};color:#fff;width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:bold;font-size:12px;border:2px solid #fff;box-shadow:0 2px 4px rgba(0,0,0,0.3)">${idx === 0 ? '🚩' : idx}</div>`, iconSize: [28, 28], iconAnchor: [14, 14] });
                            L.marker([p.latitude, p.longitude], { icon }).addTo(markersLayer);
                        }
                    });
                    if (pontos.length > 0 && pontos.some(p => p.latitude)) { const bounds = L.latLngBounds(pontos.filter(p => p.latitude).map(p => [p.latitude, p.longitude])); mapa.fitBounds(bounds, { padding: [50, 50] }); }
                }
            }, [pontos, mapa, markersLayer]);
            
            useEffect(() => {
                if (mapaAcompanhar && markersAcompanhar && detalheCorrida?.pontos) {
                    markersAcompanhar.clearLayers();
                    detalheCorrida.pontos.forEach((p, idx) => {
                        if (p.latitude && p.longitude) {
                            let cor = p.status === 'finalizado' ? '#10b981' : p.status === 'chegou' ? '#3b82f6' : idx === 0 ? '#10b981' : '#9ca3af';
                            const icon = L.divIcon({ className: '', html: `<div style="background:${cor};color:#fff;width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:bold;font-size:12px;border:2px solid #fff">${p.status === 'finalizado' ? '✓' : idx === 0 ? '🚩' : idx}</div>`, iconSize: [28, 28], iconAnchor: [14, 14] });
                            L.marker([p.latitude, p.longitude], { icon }).addTo(markersAcompanhar);
                        }
                    });
                    const pontosCoord = detalheCorrida.pontos.filter(p => p.latitude);
                    if (pontosCoord.length > 0) mapaAcompanhar.fitBounds(L.latLngBounds(pontosCoord.map(p => [p.latitude, p.longitude])), { padding: [50, 50] });
                }
            }, [detalheCorrida, mapaAcompanhar, markersAcompanhar]);
            
            const carregarHistorico = async () => { try { const resp = await fetch(`${API_URL}/api/solicitacao/historico?limite=20`, { headers: { 'Authorization': `Bearer ${token}` } }); if (resp.ok) { const data = await resp.json(); setHistorico(data.solicitacoes || []); } } catch (err) {} };
            const carregarCorridasAtivas = async () => { try { const resp = await fetch(`${API_URL}/api/solicitacao/historico?limite=50`, { headers: { 'Authorization': `Bearer ${token}` } }); if (resp.ok) { const data = await resp.json(); setCorridasAtivas((data.solicitacoes || []).filter(s => ['enviado', 'aceito', 'em_andamento'].includes(s.status))); } } catch (err) {} };
            const carregarDetalheCorrida = async (id) => { try { const resp = await fetch(`${API_URL}/api/solicitacao/corrida/${id}`, { headers: { 'Authorization': `Bearer ${token}` } }); if (resp.ok) setDetalheCorrida(await resp.json()); } catch (err) {} };
            const selecionarCorrida = (id) => { setCorridaSelecionada(id); setMapaAcompanhar(null); setMarkersAcompanhar(null); carregarDetalheCorrida(id); };
            const copiarLinkRastreio = (os) => { navigator.clipboard.writeText(`${SITE_URL}/rastrear.html?os=${os}`).then(() => showToast('✅ Link copiado!', 'success')); };
            const compartilharWhatsApp = (os) => { window.open(`https://wa.me/?text=${encodeURIComponent(`🏍️ Acompanhe sua entrega:\n${SITE_URL}/rastrear.html?os=${os}`)}`, '_blank'); };
            
            const agruparCorridasPorProfissional = () => {
                const grupos = {};
                corridasAtivas.forEach(corrida => {
                    const chave = corrida.profissional_nome || '__SEM_PROFISSIONAL__';
                    if (!grupos[chave]) { grupos[chave] = { nome: corrida.profissional_nome || null, foto: corrida.profissional_foto || null, placa: corrida.profissional_placa || null, corridas: [] }; }
                    grupos[chave].corridas.push(corrida);
                });
                const resultado = [];
                Object.keys(grupos).sort((a, b) => { if (a === '__SEM_PROFISSIONAL__') return 1; if (b === '__SEM_PROFISSIONAL__') return -1; return a.localeCompare(b); }).forEach(chave => { resultado.push({ chave, ...grupos[chave] }); });
                return resultado;
            };
            
            const toggleGrupo = (chave) => { setGruposExpandidos(prev => ({ ...prev, [chave]: !prev[chave] })); };
            
            const buscarEndereco = async () => {
                if (!termoBusca || termoBusca.length < 3) { showToast('Digite pelo menos 3 caracteres', 'warning'); return; }
                setBuscando(true);
                try { const resp = await fetch(`${API_URL}/api/geocode/google?endereco=${encodeURIComponent(termoBusca)}`); if (resp.ok) { const data = await resp.json(); if (data.results?.length > 0) setSugestoes(data.results); else showToast('Nenhum endereço', 'warning'); } }
                catch (err) { showToast('Erro', 'error'); }
                setBuscando(false);
            };
            
            const adicionarPonto = (sug) => {
                if (pontos.length >= 80) { showToast('Máximo 80 pontos', 'error'); return; }
                const comp = sug.componentes || [];
                const get = (t) => comp.find(c => c.types?.includes(t))?.long_name || '';
                const getS = (t) => comp.find(c => c.types?.includes(t))?.short_name || '';
                const novoPonto = { id: Date.now(), endereco_completo: sug.endereco || '', rua: get('route'), numero: get('street_number'), bairro: get('sublocality_level_1') || get('sublocality'), cidade: get('administrative_area_level_2') || get('locality'), uf: getS('administrative_area_level_1'), cep: get('postal_code'), latitude: sug.latitude, longitude: sug.longitude, observacao: '', telefone: '', procurar_por: '', numero_nota: '', codigo_finalizar: '' };
                setPontos([...pontos, novoPonto]); setTermoBusca(''); setSugestoes([]); showToast('✅ Adicionado', 'success');
            };
            
            const removerPonto = (id) => setPontos(pontos.filter(p => p.id !== id));
            const moverPonto = (idx, dir) => { const lista = [...pontos]; const n = idx + dir; if (n >= 0 && n < lista.length) { [lista[idx], lista[n]] = [lista[n], lista[idx]]; setPontos(lista); } };
            const abrirEdicaoPonto = (idx) => { const p = pontos[idx]; setDadosPonto({ observacao: p.observacao || '', telefone: p.telefone || '', procurar_por: p.procurar_por || '', numero_nota: p.numero_nota || '', codigo_finalizar: p.codigo_finalizar || '' }); setPontoEditando(idx); };
            const salvarEdicaoPonto = () => { const n = [...pontos]; n[pontoEditando] = { ...n[pontoEditando], ...dadosPonto }; setPontos(n); setPontoEditando(null); showToast('✅ Salvo', 'success'); };
            const salvarPartidaPadrao = async () => { if (pontos.length === 0) return; try { await fetch(`${API_URL}/api/solicitacao/configuracoes`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }, body: JSON.stringify({ endereco_partida_padrao: pontos[0] }) }); showToast('✅ Salvo!', 'success'); } catch {} };
            const limpar = () => { if (cliente.endereco_partida_padrao) setPontos([{ id: Date.now(), ...cliente.endereco_partida_padrao, isPartida: true }]); else setPontos([]); setSugestoes([]); setTermoBusca(''); };
            
            const enviarSolicitacao = async () => {
                if (pontos.length < 2) { showToast('Mínimo 2 pontos', 'error'); return; }
                if (config.ordenar && pontos.length > 20) { showToast('Ordenação: máx 20 pts', 'warning'); return; }
                setLoading(true);
                try {
                    const dataRet = config.data_retirada && config.hora_retirada ? `${config.data_retirada} ${config.hora_retirada}:00` : '';
                    const payload = { numero_pedido: config.numero_pedido, centro_custo: config.centro_custo, usuario_solicitante: config.usuario_solicitante, data_retirada: dataRet, forma_pagamento: config.forma_pagamento, ponto_receber: config.ponto_receber ? parseInt(config.ponto_receber) : null, retorno: config.retorno, obs_retorno: config.obs_retorno, ordenar: config.ordenar, codigo_profissional: config.codigo_profissional, sem_profissional: config.sem_profissional, pontos: pontos.map(p => ({ rua: p.rua || '', numero: p.numero || '', complemento: p.complemento || '', bairro: p.bairro || '', cidade: p.cidade || '', uf: p.uf || '', cep: p.cep || '', latitude: p.latitude, longitude: p.longitude, observacao: p.observacao || '', telefone: p.telefone || '', procurar_por: p.procurar_por || '', numero_nota: p.numero_nota || '', codigo_finalizar: p.codigo_finalizar || '', endereco_completo: p.endereco_completo || '' })) };
                    const resp = await fetch(`${API_URL}/api/solicitacao/corrida`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }, body: JSON.stringify(payload) });
                    const data = await resp.json();
                    if (resp.ok) { const motoboy = config.codigo_profissional ? profissionais.find(p => p.codigo === config.codigo_profissional)?.nome : null; const msgMotoboy = motoboy ? ` → ${motoboy}` : ''; showToast(`✅ OS: ${data.os_numero}${msgMotoboy}${data.modo_teste ? ' (TESTE)' : ''}`, 'success'); limpar(); setConfig(prev => ({ ...prev, codigo_profissional: '' })); carregarHistorico(); carregarCorridasAtivas(); }
                    else showToast(data.error || 'Erro', 'error');
                } catch { showToast('Erro', 'error'); }
                setLoading(false);
            };
            
            const statusCores = { enviado: 'bg-yellow-100 text-yellow-800', aceito: 'bg-blue-100 text-blue-800', em_andamento: 'bg-purple-100 text-purple-800', finalizado: 'bg-green-100 text-green-800', cancelado: 'bg-red-100 text-red-800', erro: 'bg-red-100 text-red-800' };
            const statusNomes = { enviado: '📤 Aguardando', aceito: '✅ Aceito', em_andamento: '🏍️ Em andamento', finalizado: '🏁 Finalizado', cancelado: '❌ Cancelado', erro: '⚠️ Erro' };
            const statusPontoCores = { pendente: 'bg-gray-100 border-gray-300', chegou: 'bg-blue-100 border-blue-300', coletado: 'bg-yellow-100 border-yellow-300', finalizado: 'bg-green-100 border-green-300' };
            const formatarData = (d) => d ? new Date(d).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
            
            const gruposAgrupados = agruparCorridasPorProfissional();
            
            return (
                <div className="min-h-screen bg-gray-100">
                    <header className="bg-blue-900 text-white px-3 py-2 shadow-lg">
                        <div className="max-w-7xl mx-auto flex items-center justify-between">
                            <div className="flex items-center gap-2"><span className="text-xl">🏍️</span><div><h1 className="font-bold text-sm md:text-lg">Central Tutts</h1><p className="text-xs text-blue-200 hidden md:block">{cliente.empresa || cliente.nome}</p></div></div>
                            <div className="flex items-center gap-2"><button onClick={() => setMostrarHistorico(true)} className="text-xs bg-blue-800 hover:bg-blue-700 px-2 py-1 rounded">📋 Histórico</button><button onClick={onLogout} className="text-xs bg-red-600 hover:bg-red-700 px-2 py-1 rounded">Sair</button></div>
                        </div>
                    </header>
                    
                    <div className="bg-white shadow border-b">
                        <div className="max-w-7xl mx-auto flex">
                            <button onClick={() => { setAbaAtiva('nova'); setCorridaSelecionada(null); }} className={`flex-1 md:flex-none px-4 py-3 text-sm font-medium border-b-2 ${abaAtiva === 'nova' ? 'text-blue-600 border-blue-600 bg-blue-50' : 'text-gray-500 border-transparent'}`}>📝 Nova Corrida</button>
                            <button onClick={() => { setAbaAtiva('acompanhar'); carregarCorridasAtivas(); }} className={`flex-1 md:flex-none px-4 py-3 text-sm font-medium border-b-2 flex items-center justify-center gap-2 ${abaAtiva === 'acompanhar' ? 'text-blue-600 border-blue-600 bg-blue-50' : 'text-gray-500 border-transparent'}`}>🗺️ Acompanhar {corridasAtivas.length > 0 && <span className="bg-red-500 text-white text-xs px-1.5 py-0.5 rounded-full">{corridasAtivas.length}</span>}</button>
                        </div>
                    </div>
                    
                    {abaAtiva === 'nova' && (
                        <>
                            <div className="md:hidden flex bg-white shadow"><button onClick={() => setAbaMobile('form')} className={`flex-1 py-2 text-sm ${abaMobile === 'form' ? 'text-blue-600 border-b-2 border-blue-600' : 'text-gray-500'}`}>📝 Form</button><button onClick={() => setAbaMobile('mapa')} className={`flex-1 py-2 text-sm ${abaMobile === 'mapa' ? 'text-blue-600 border-b-2 border-blue-600' : 'text-gray-500'}`}>🗺️ Mapa</button></div>
                            <div className="max-w-7xl mx-auto p-2 md:p-4">
                                <div className="flex flex-col md:flex-row gap-4">
                                    <div className={`${abaMobile === 'form' ? 'block' : 'hidden'} md:block w-full md:w-96 space-y-3`}>
                                        {/* PONTO DE PARTIDA */}
                                        <div className="bg-gradient-to-r from-green-50 to-emerald-50 rounded-xl shadow border-2 border-green-200 p-3">
                                            <div className="flex items-center justify-between mb-2">
                                                <span className="text-sm font-bold text-green-800">🟢 PONTO DE PARTIDA</span>
                                                {pontos.length > 0 && pontos[0] && <button onClick={salvarPartidaPadrao} className="text-xs text-green-600 hover:text-green-800 font-medium">⭐ Tornar Padrão</button>}
                                            </div>
                                            {pontos.length === 0 || !pontos[0] ? (
                                                <div>
                                                    <div className="flex gap-2">
                                                        <input type="text" value={termoBusca} onChange={(e) => setTermoBusca(e.target.value)} onKeyPress={(e) => e.key === 'Enter' && buscarEndereco()} className="flex-1 px-3 py-2 border border-green-300 rounded-lg text-sm outline-none bg-white" placeholder="Buscar endereço de partida..." />
                                                        <button onClick={buscarEndereco} disabled={buscando} className="px-3 py-2 bg-green-600 text-white rounded-lg text-sm">{buscando ? '...' : '🔍'}</button>
                                                    </div>
                                                    {sugestoes.length > 0 && <div className="mt-2 bg-white border border-green-200 rounded-lg max-h-40 overflow-y-auto">{sugestoes.map((s, i) => <div key={i} onClick={() => adicionarPonto(s)} className="p-2 hover:bg-green-50 cursor-pointer text-xs border-b">📍 {s.endereco}</div>)}</div>}
                                                </div>
                                            ) : (
                                                <div className="bg-white rounded-lg p-2 border border-green-200">
                                                    <div className="flex items-center gap-2">
                                                        <span className="w-7 h-7 rounded-full bg-green-500 flex items-center justify-center text-white text-sm font-bold">🚩</span>
                                                        <div className="flex-1 min-w-0"><div className="text-xs font-medium truncate">{pontos[0].endereco_completo || `${pontos[0].rua}, ${pontos[0].numero}`}</div>{pontos[0].observacao && <div className="text-xs text-gray-500 truncate">📝 {pontos[0].observacao}</div>}</div>
                                                        <div className="flex gap-1"><button onClick={() => abrirEdicaoPonto(0)} className="text-gray-400 hover:text-green-600 text-sm">✏️</button><button onClick={() => removerPonto(pontos[0].id)} className="text-gray-400 hover:text-red-600">✕</button></div>
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                        
                                        {/* PONTOS DE ENTREGA */}
                                        <div className="bg-white rounded-xl shadow p-3">
                                            <div className="flex items-center justify-between mb-2">
                                                <span className="text-sm font-bold text-blue-800">📦 PONTOS DE ENTREGA ({Math.max(0, pontos.length - 1)}/79)</span>
                                                {pontos.length > 1 && <button onClick={() => setPontos(pontos.slice(0, 1))} className="text-xs text-red-500 hover:text-red-700">Limpar entregas</button>}
                                            </div>
                                            {pontos.length > 0 && (
                                                <div className="mb-2">
                                                    <div className="flex gap-2">
                                                        <input type="text" value={termoBusca} onChange={(e) => setTermoBusca(e.target.value)} onKeyPress={(e) => e.key === 'Enter' && buscarEndereco()} className="flex-1 px-3 py-2 border rounded-lg text-sm outline-none" placeholder="Buscar endereço de entrega..." />
                                                        <button onClick={buscarEndereco} disabled={buscando} className="px-3 py-2 bg-blue-600 text-white rounded-lg text-sm">{buscando ? '...' : '🔍'}</button>
                                                    </div>
                                                    {sugestoes.length > 0 && <div className="mt-2 bg-white border rounded-lg max-h-40 overflow-y-auto">{sugestoes.map((s, i) => <div key={i} onClick={() => adicionarPonto(s)} className="p-2 hover:bg-blue-50 cursor-pointer text-xs border-b">📍 {s.endereco}</div>)}</div>}
                                                </div>
                                            )}
                                            <div className="space-y-2 max-h-40 overflow-y-auto">
                                                {pontos.length <= 1 ? <div className="text-center py-3 text-gray-400 text-sm">{pontos.length === 0 ? 'Defina a partida primeiro' : 'Adicione pontos de entrega'}</div> : pontos.slice(1).map((p, idx) => (
                                                    <div key={p.id} className="p-2 rounded-lg border bg-blue-50 border-blue-200">
                                                        <div className="flex items-center gap-2">
                                                            <span className="w-6 h-6 rounded-full bg-blue-600 flex items-center justify-center text-white text-xs font-bold">{idx + 1}</span>
                                                            <div className="flex-1 min-w-0"><div className="text-xs font-medium truncate">{p.endereco_completo || `${p.rua}, ${p.numero}`}</div>{p.observacao && <div className="text-xs text-gray-500 truncate">📝 {p.observacao}</div>}</div>
                                                            <div className="flex gap-1"><button onClick={() => abrirEdicaoPonto(idx + 1)} className="text-gray-400 hover:text-blue-600 text-sm">✏️</button>{idx > 0 && <button onClick={() => moverPonto(idx + 1, -1)} className="text-gray-400">▲</button>}{idx < pontos.length - 2 && <button onClick={() => moverPonto(idx + 1, 1)} className="text-gray-400">▼</button>}<button onClick={() => removerPonto(p.id)} className="text-gray-400 hover:text-red-600">✕</button></div>
                                                        </div>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                        <div className="bg-white rounded-xl shadow p-3">
                                            <div className="text-sm font-bold text-gray-700 mb-3">⚙️ Configurações</div>
                                            <div className="grid grid-cols-2 gap-2">
                                                <div><label className="text-xs text-gray-600">Pedido</label><input type="text" value={config.numero_pedido} onChange={(e) => setConfig({...config, numero_pedido: e.target.value})} className="w-full px-2 py-1.5 border rounded text-sm" /></div>
                                                <div><label className="text-xs text-gray-600">Centro Custo</label><input type="text" value={config.centro_custo} onChange={(e) => setConfig({...config, centro_custo: e.target.value})} className="w-full px-2 py-1.5 border rounded text-sm" /></div>
                                            </div>
                                            <div className="grid grid-cols-2 gap-2 mt-2">
                                                <div><label className="text-xs text-gray-600">Pagamento</label><select value={config.forma_pagamento} onChange={(e) => setConfig({...config, forma_pagamento: e.target.value})} className="w-full px-2 py-1.5 border rounded text-sm"><option value="F">A Faturar</option><option value="D">Dinheiro</option><option value="C">Cartão</option></select></div>
                                                <div><label className="text-xs text-gray-600">Receber ponto</label><input type="number" value={config.ponto_receber} onChange={(e) => setConfig({...config, ponto_receber: e.target.value})} className="w-full px-2 py-1.5 border rounded text-sm" min="1" /></div>
                                            </div>
                                            <div className="mt-2">
                                                <label className="text-xs text-gray-600">🏍️ Motoboy Específico</label>
                                                <select value={config.codigo_profissional} onChange={(e) => setConfig({...config, codigo_profissional: e.target.value})} className={`w-full px-2 py-1.5 border rounded text-sm ${config.codigo_profissional ? 'border-green-400 bg-green-50' : ''}`} disabled={carregandoProfissionais || profissionais.length === 0}>
                                                    <option value="">{carregandoProfissionais ? '⏳ Carregando...' : profissionais.length === 0 ? '❌ Nenhum disponível' : '🔄 Disparar para todos'}</option>
                                                    {profissionais.map(p => (<option key={p.codigo} value={p.codigo}>{p.nome}</option>))}
                                                </select>
                                                {config.codigo_profissional && <div className="text-xs text-green-600 mt-1">✅ Corrida será enviada apenas para: {profissionais.find(p => p.codigo === config.codigo_profissional)?.nome}</div>}
                                            </div>
                                            <div className="flex flex-wrap gap-4 mt-3">
                                                <label className="flex items-center gap-2 text-sm cursor-pointer"><input type="checkbox" checked={config.ordenar} onChange={(e) => setConfig({...config, ordenar: e.target.checked})} className="w-4 h-4" />🔀 Ordenar</label>
                                                <label className="flex items-center gap-2 text-sm cursor-pointer"><input type="checkbox" checked={config.retorno} onChange={(e) => setConfig({...config, retorno: e.target.checked})} className="w-4 h-4" />↩️ Retornar</label>
                                            </div>
                                            <div className="mt-3 pt-3 border-t border-orange-200 bg-orange-50 -mx-3 px-3 pb-2 rounded-b-xl">
                                                <label className="flex items-center gap-2 text-sm cursor-pointer"><input type="checkbox" checked={config.sem_profissional} onChange={(e) => setConfig({...config, sem_profissional: e.target.checked})} className="w-4 h-4 accent-orange-500" /><span className="text-orange-700 font-medium">🧪 Modo Teste</span></label>
                                            </div>
                                        </div>
                                        <button onClick={enviarSolicitacao} disabled={loading || pontos.length < 2} className={`w-full py-3 text-white rounded-xl font-bold text-sm shadow-lg disabled:opacity-50 ${config.sem_profissional ? 'bg-orange-500' : config.codigo_profissional ? 'bg-green-600' : 'bg-blue-600'}`}>
                                            {loading ? '⏳...' : config.sem_profissional ? `🧪 Testar (${pontos.length})` : config.codigo_profissional ? `🏍️ Enviar para ${profissionais.find(p => p.codigo === config.codigo_profissional)?.nome?.split(' ')[0] || 'Motoboy'} (${pontos.length})` : `🚀 Solicitar (${pontos.length})`}
                                        </button>
                                    </div>
                                    <div className={`${abaMobile === 'mapa' ? 'block' : 'hidden'} md:block flex-1`}><div id="mapa" className="rounded-xl shadow-lg" style={{ height: 'calc(100vh - 200px)', minHeight: '400px' }}></div></div>
                                </div>
                            </div>
                        </>
                    )}
                    
                    {abaAtiva === 'acompanhar' && (
                        <div className="max-w-7xl mx-auto p-2 md:p-4">
                            <div className="flex flex-col md:flex-row gap-4">
                                <div className="w-full md:w-80 space-y-3">
                                    <div className="bg-white rounded-xl shadow p-3">
                                        <div className="text-sm font-bold text-gray-700 mb-3">🏍️ Corridas Ativas ({corridasAtivas.length})</div>
                                        {corridasAtivas.length === 0 ? (<div className="text-center py-8 text-gray-400"><div className="text-4xl mb-2">📭</div><div className="text-sm">Nenhuma corrida ativa</div></div>) : (
                                            <div className="space-y-3 max-h-[calc(100vh-280px)] overflow-y-auto">
                                                {gruposAgrupados.map(grupo => (
                                                    <div key={grupo.chave} className="border rounded-lg overflow-hidden">
                                                        <div onClick={() => toggleGrupo(grupo.chave)} className={`p-3 cursor-pointer flex items-center gap-3 ${grupo.nome ? 'bg-gradient-to-r from-blue-50 to-blue-100 border-b border-blue-200' : 'bg-gradient-to-r from-orange-50 to-orange-100 border-b border-orange-200'}`}>
                                                            {grupo.nome ? (<>{grupo.foto ? (<img src={grupo.foto} className="w-10 h-10 rounded-full object-cover border-2 border-blue-300" />) : (<div className="w-10 h-10 rounded-full bg-blue-200 flex items-center justify-center text-lg">🏍️</div>)}<div className="flex-1 min-w-0"><div className="font-bold text-gray-800 truncate">{grupo.nome}</div>{grupo.placa && <div className="text-xs text-gray-500">{grupo.placa}</div>}</div></>) : (<><div className="w-10 h-10 rounded-full bg-orange-200 flex items-center justify-center text-lg">⏳</div><div className="flex-1"><div className="font-bold text-orange-700">Sem Profissional</div><div className="text-xs text-orange-500">Aguardando atribuição</div></div></>)}
                                                            <div className="flex items-center gap-2"><span className={`px-2 py-1 rounded-full text-xs font-bold ${grupo.nome ? 'bg-blue-500 text-white' : 'bg-orange-500 text-white'}`}>{grupo.corridas.length}</span><span className="text-gray-400 text-sm">{gruposExpandidos[grupo.chave] !== false ? '▼' : '▶'}</span></div>
                                                        </div>
                                                        {gruposExpandidos[grupo.chave] !== false && (
                                                            <div className="divide-y divide-gray-100">
                                                                {grupo.corridas.map(c => (
                                                                    <div key={c.id} onClick={() => selecionarCorrida(c.id)} className={`p-3 cursor-pointer transition-colors ${corridaSelecionada === c.id ? 'bg-blue-50 border-l-4 border-l-blue-500' : 'hover:bg-gray-50'}`}>
                                                                        <div className="flex items-center justify-between"><div><div className="font-bold text-gray-800 text-sm">OS #{c.tutts_os_numero || c.id}</div><div className="text-xs text-gray-500">{c.total_pontos} pts • {formatarData(c.criado_em)}</div></div><span className={`px-2 py-1 rounded text-xs font-medium ${statusCores[c.status]}`}>{statusNomes[c.status]}</span></div>
                                                                        {c.tutts_valor && (<div className="text-xs text-green-600 mt-1 font-medium">R$ {parseFloat(c.tutts_valor).toFixed(2)}</div>)}
                                                                    </div>
                                                                ))}
                                                            </div>
                                                        )}
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                </div>
                                <div className="flex-1">
                                    {!corridaSelecionada ? (<div className="bg-white rounded-xl shadow p-8 text-center text-gray-400"><div className="text-6xl mb-4">👈</div><div>Selecione uma corrida para ver detalhes</div></div>) : !detalheCorrida ? (<div className="bg-white rounded-xl shadow p-8 text-center"><div className="text-2xl">⏳</div></div>) : (
                                        <div className="space-y-4">
                                            <div className={`p-4 rounded-xl border-2 ${statusCores[detalheCorrida.status]}`}>
                                                <div className="flex items-center justify-between flex-wrap gap-2">
                                                    <div><div className="text-xl font-bold">OS #{detalheCorrida.tutts_os_numero || detalheCorrida.id}</div><span className={`inline-block px-3 py-1 rounded-full text-sm font-medium ${statusCores[detalheCorrida.status]}`}>{statusNomes[detalheCorrida.status]}</span></div>
                                                    <div className="flex gap-2"><button onClick={() => copiarLinkRastreio(detalheCorrida.tutts_os_numero)} className="px-3 py-2 bg-gray-100 hover:bg-gray-200 rounded-lg text-sm font-medium">📋 Copiar</button><button onClick={() => compartilharWhatsApp(detalheCorrida.tutts_os_numero)} className="px-3 py-2 bg-green-500 text-white rounded-lg text-sm font-medium">📱 WhatsApp</button></div>
                                                </div>
                                                {!['finalizado', 'cancelado'].includes(detalheCorrida.status) && (<div className="flex items-center gap-2 mt-2 text-xs text-gray-500"><div className="w-2 h-2 bg-green-500 rounded-full animate-pulse-custom"></div>Atualizando automaticamente...</div>)}
                                            </div>
                                            {detalheCorrida.profissional_nome && (<div className="bg-white p-4 rounded-xl shadow"><div className="text-sm font-bold text-gray-500 mb-3">🏍️ Motoboy</div><div className="flex items-center gap-4">{detalheCorrida.profissional_foto ? (<img src={detalheCorrida.profissional_foto} className="w-14 h-14 rounded-full object-cover border-2 border-blue-200" />) : (<div className="w-14 h-14 rounded-full bg-blue-100 flex items-center justify-center text-2xl">🏍️</div>)}<div><div className="font-bold text-gray-800">{detalheCorrida.profissional_nome}</div>{detalheCorrida.profissional_placa && <div className="text-sm text-gray-500">🏍️ {detalheCorrida.profissional_placa}</div>}</div></div></div>)}
                                            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                                                {detalheCorrida.tutts_distancia && <div className="bg-white p-3 rounded-xl shadow text-center"><div className="text-xl font-bold text-blue-600">{detalheCorrida.tutts_distancia} km</div><div className="text-xs text-gray-500">Distância</div></div>}
                                                {detalheCorrida.tutts_duracao && <div className="bg-white p-3 rounded-xl shadow text-center"><div className="text-xl font-bold text-blue-600">{detalheCorrida.tutts_duracao}</div><div className="text-xs text-gray-500">Tempo</div></div>}
                                                {detalheCorrida.tutts_valor && <div className="bg-white p-3 rounded-xl shadow text-center"><div className="text-xl font-bold text-green-600">R$ {parseFloat(detalheCorrida.tutts_valor).toFixed(2)}</div><div className="text-xs text-gray-500">Valor</div></div>}
                                                <div className="bg-white p-3 rounded-xl shadow text-center"><div className="text-xl font-bold text-purple-600">{detalheCorrida.pontos?.length || 0}</div><div className="text-xs text-gray-500">Pontos</div></div>
                                            </div>
                                            <div className="flex flex-col md:flex-row gap-4">
                                                <div className="w-full md:w-72 bg-white p-4 rounded-xl shadow">
                                                    <div className="text-sm font-bold text-gray-500 mb-3">📍 Pontos</div>
                                                    <div className="space-y-2 max-h-64 overflow-y-auto">
                                                        {detalheCorrida.pontos?.map((p, idx) => (
                                                            <div key={idx} className={`p-2 rounded-lg border ${statusPontoCores[p.status] || 'bg-gray-50'}`}>
                                                                <div className="flex items-center gap-2">
                                                                    <div className={`w-7 h-7 rounded-full flex items-center justify-center text-white text-xs font-bold ${p.status === 'finalizado' ? 'bg-green-500' : p.status === 'chegou' ? 'bg-blue-500' : idx === 0 ? 'bg-green-500' : 'bg-gray-400'}`}>{p.status === 'finalizado' ? '✓' : idx === 0 ? '🚩' : idx}</div>
                                                                    <div className="flex-1 min-w-0"><div className="text-xs font-medium truncate">{idx === 0 ? 'Partida' : `Entrega ${idx}`}</div><div className="text-xs text-gray-500 truncate">{p.bairro}, {p.cidade}</div></div>
                                                                    {p.status === 'chegou' && <span className="text-xs text-blue-600 animate-pulse-custom">📍</span>}
                                                                </div>
                                                            </div>
                                                        ))}
                                                    </div>
                                                </div>
                                                <div className="flex-1"><div id="mapaAcompanhar" className="rounded-xl shadow-lg" style={{ height: '300px' }}></div></div>
                                            </div>
                                            {detalheCorrida.tutts_url_rastreamento && (<a href={detalheCorrida.tutts_url_rastreamento} target="_blank" className="block w-full py-3 bg-gray-800 text-white rounded-xl font-bold text-center hover:bg-gray-900">🗺️ Abrir Rastreamento Tutts</a>)}
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>
                    )}
                    
                    {pontoEditando !== null && (
                        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => setPontoEditando(null)}>
                            <div className="bg-white rounded-xl shadow-2xl w-full max-w-md p-4" onClick={e => e.stopPropagation()}>
                                <div className="flex items-center justify-between mb-4"><span className="font-bold">✏️ Editar Ponto {pontoEditando + 1}</span><button onClick={() => setPontoEditando(null)} className="text-gray-400">✕</button></div>
                                <div className="space-y-3">
                                    <div><label className="text-xs text-gray-600">Observação</label><textarea value={dadosPonto.observacao} onChange={(e) => setDadosPonto({...dadosPonto, observacao: e.target.value})} className="w-full px-3 py-2 border rounded text-sm" rows="2" /></div>
                                    <div className="grid grid-cols-2 gap-3"><div><label className="text-xs text-gray-600">Telefone</label><input type="text" value={dadosPonto.telefone} onChange={(e) => setDadosPonto({...dadosPonto, telefone: e.target.value})} className="w-full px-3 py-2 border rounded text-sm" /></div><div><label className="text-xs text-gray-600">Procurar</label><input type="text" value={dadosPonto.procurar_por} onChange={(e) => setDadosPonto({...dadosPonto, procurar_por: e.target.value})} className="w-full px-3 py-2 border rounded text-sm" /></div></div>
                                </div>
                                <div className="flex gap-2 mt-4"><button onClick={() => setPontoEditando(null)} className="flex-1 py-2 border rounded-lg text-sm">Cancelar</button><button onClick={salvarEdicaoPonto} className="flex-1 py-2 bg-blue-600 text-white rounded-lg text-sm">Salvar</button></div>
                            </div>
                        </div>
                    )}
                    
                    {mostrarHistorico && (
                        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => setMostrarHistorico(false)}>
                            <div className="bg-white rounded-xl shadow-2xl w-full max-w-3xl max-h-[80vh] overflow-hidden" onClick={e => e.stopPropagation()}>
                                <div className="bg-blue-900 text-white px-4 py-3 flex items-center justify-between"><span className="font-bold">📋 Histórico</span><button onClick={() => setMostrarHistorico(false)} className="text-white/70">✕</button></div>
                                <div className="p-4 overflow-y-auto max-h-[65vh]">
                                    {historico.length === 0 ? <p className="text-center text-gray-500 py-8">Nenhuma solicitação</p> : (
                                        <div className="space-y-2">{historico.map(h => (
                                            <div key={h.id} className="p-3 border rounded-lg hover:bg-gray-50">
                                                <div className="flex items-center justify-between">
                                                    <div><div className="flex items-center gap-2"><span className={`px-2 py-0.5 rounded text-xs font-medium ${statusCores[h.status]}`}>{statusNomes[h.status]}</span>{h.tutts_os_numero && <span className="text-sm font-medium">OS #{h.tutts_os_numero}</span>}</div><div className="text-xs text-gray-500 mt-1">{formatarData(h.criado_em)} • {h.total_pontos} pts{h.profissional_nome && ` • 🏍️ ${h.profissional_nome}`}</div></div>
                                                    <div className="flex items-center gap-2">{h.tutts_valor && <div className="text-sm font-bold text-green-600">R$ {parseFloat(h.tutts_valor).toFixed(2)}</div>}{h.tutts_os_numero && <button onClick={() => copiarLinkRastreio(h.tutts_os_numero)} className="text-xs text-blue-600">📋</button>}</div>
                                                </div>
                                            </div>
                                        ))}</div>
                                    )}
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            );
        };
        
        const App = () => {
            const [cliente, setCliente] = useState(null);
            const [token, setToken] = useState(null);
            const [toast, setToast] = useState(null);
            const [verificando, setVerificando] = useState(true);
            const showToast = (msg, tipo = 'info') => setToast({ mensagem: msg, tipo });
            
            useEffect(() => {
                const verificar = async () => {
                    const t = localStorage.getItem('solicitacao_token');
                    const c = localStorage.getItem('solicitacao_cliente');
                    if (t && c) { try { const r = await fetch(`${API_URL}/api/solicitacao/verificar`, { headers: { 'Authorization': `Bearer ${t}` } }); if (r.ok) { const d = await r.json(); setToken(t); setCliente(d.cliente); } else { localStorage.removeItem('solicitacao_token'); localStorage.removeItem('solicitacao_cliente'); } } catch {} }
                    setVerificando(false);
                };
                verificar();
            }, []);
            
            if (verificando) return <div className="min-h-screen bg-blue-100 flex items-center justify-center"><div className="text-center"><div className="text-4xl mb-4">🏍️</div><p>Carregando...</p></div></div>;
            return (<>{toast && <Toast mensagem={toast.mensagem} tipo={toast.tipo} onClose={() => setToast(null)} />}{cliente && token ? <Solicitacao cliente={cliente} token={token} onLogout={() => { localStorage.removeItem('solicitacao_token'); localStorage.removeItem('solicitacao_cliente'); setCliente(null); setToken(null); }} showToast={showToast} /> : <TelaLogin onLogin={(c, t) => { setCliente(c); setToken(t); }} showToast={showToast} />}</>);
        };
        
        ReactDOM.createRoot(document.getElementById('root')).render(<App />);
    </script>
</body>
</html>
