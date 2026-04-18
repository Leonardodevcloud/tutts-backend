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
    <!-- Google Maps JS é carregado dinamicamente via /api/solicitacao/maps-key após login -->
    <script src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
    <script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
    <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
    <style>
        @keyframes fadeIn { from { opacity: 0; transform: translateY(-10px); } to { opacity: 1; transform: translateY(0); } }
        .fade-in { animation: fadeIn 0.3s ease-out; }
        #mapa, #mapaAcompanhar { z-index: 1; }
        .leaflet-container { width: 100% !important; height: 100% !important; background: #e5e7eb; z-index: 1 !important; }
        .leaflet-pane { z-index: 1 !important; }
        .leaflet-top, .leaflet-bottom { z-index: 10 !important; }
        ::-webkit-scrollbar { width: 6px; height: 6px; }
        ::-webkit-scrollbar-track { background: #f1f1f1; border-radius: 3px; }
        ::-webkit-scrollbar-thumb { background: #93c5fd; border-radius: 3px; }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
        .animate-pulse-custom { animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite; }
        .map-container { position: relative; z-index: 1; }
        @keyframes slideDown { from { opacity: 0; max-height: 0; } to { opacity: 1; max-height: 100px; } }
        .slide-down { animation: slideDown 0.3s ease-out forwards; overflow: hidden; }
        .foto-modal { z-index: 9999 !important; }
    </style>
</head>
<body class="bg-gray-100 min-h-screen">
    <div id="root"></div>
    
    <script type="text/babel">
        const { useState, useEffect, useRef, useCallback } = React;
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
                <div className="min-h-screen bg-gray-100 flex items-center justify-center p-4">
                    <div className="bg-white rounded-3xl shadow-2xl p-6 w-full max-w-sm">
                        {/* Logo */}
                        <div className="text-center mb-4">
                            <img 
                                src="https://github.com/Leonardodevcloud/tutts-frontend/blob/main/logotuttsoriginal.png?raw=true" 
                                alt="Tutts Logo" 
                                className="w-28 h-auto mx-auto mb-3 drop-shadow-lg rounded-2xl"
                            />
                            <h1 className="text-lg font-bold text-gray-700">Central de Solicitações</h1>
                            <p className="text-xs text-gray-500">Faça login para continuar</p>
                        </div>
                        
                        <form onSubmit={handleSubmit} className="space-y-4">
                            <div>
                                <label className="block text-sm font-semibold text-gray-700 mb-1">📧 Email</label>
                                <input 
                                    type="email" 
                                    value={email} 
                                    onChange={(e) => setEmail(e.target.value)} 
                                    className="w-full px-4 py-2.5 rounded-xl border-2 border-gray-200 focus:border-purple-500 focus:ring-2 focus:ring-purple-200 outline-none transition-all text-sm" 
                                    placeholder="seu@email.com" 
                                />
                            </div>
                            <div>
                                <label className="block text-sm font-semibold text-gray-700 mb-1">🔒 Senha</label>
                                <input 
                                    type="password" 
                                    value={senha} 
                                    onChange={(e) => setSenha(e.target.value)} 
                                    className="w-full px-4 py-2.5 rounded-xl border-2 border-gray-200 focus:border-purple-500 focus:ring-2 focus:ring-purple-200 outline-none transition-all text-sm" 
                                    placeholder="••••••••" 
                                />
                            </div>
                            <button 
                                type="submit" 
                                disabled={loading} 
                                className="w-full py-3 bg-purple-600 hover:bg-purple-700 text-white font-bold rounded-xl disabled:opacity-50 transition-all shadow-lg hover:shadow-xl"
                            >
                                {loading ? '⏳ Entrando...' : '🚀 Entrar'}
                            </button>
                        </form>
                        
                        <div className="mt-4 text-center text-xs text-gray-400">
                            © 2026 Tutts - Todos os direitos reservados
                        </div>
                    </div>
                </div>
            );
        };
        
        // Componente de Mapa reutilizável com controle de ciclo de vida
        const MapaLeaflet = ({ id, pontos, center = [-12.9714, -38.5014], zoom = 12, height = '400px', tipo = 'nova' }) => {
            const mapRef = useRef(null);
            const mapInstanceRef = useRef(null);
            const markersLayerRef = useRef(null);
            
            useEffect(() => {
                if (typeof L === 'undefined') return;
                const container = mapRef.current;
                if (!container) return;
                if (mapInstanceRef.current) { mapInstanceRef.current.remove(); mapInstanceRef.current = null; }
                const map = L.map(container, { center: center, zoom: zoom, zoomControl: true });
                L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
                const markersLayer = L.layerGroup().addTo(map);
                mapInstanceRef.current = map;
                markersLayerRef.current = markersLayer;
                setTimeout(() => { if (mapInstanceRef.current) mapInstanceRef.current.invalidateSize(); }, 100);
                return () => { if (mapInstanceRef.current) { mapInstanceRef.current.remove(); mapInstanceRef.current = null; } };
            }, [id]);
            
            useEffect(() => {
                const map = mapInstanceRef.current;
                const markersLayer = markersLayerRef.current;
                if (!map || !markersLayer || !pontos) return;
                markersLayer.clearLayers();
                const pontosValidos = pontos.filter(p => p.latitude && p.longitude);
                pontosValidos.forEach((p, idx) => {
                    let cor, icone;
                    if (tipo === 'acompanhar') {
                        if (p.status === 'finalizado') { cor = '#10b981'; icone = '✓'; }
                        else if (p.status === 'chegou' || p.status === 'coletado') { cor = '#3b82f6'; icone = '📍'; }
                        else if (idx === 0) { cor = '#f59e0b'; icone = '📦'; }
                        else { cor = '#9ca3af'; icone = idx; }
                    } else {
                        if (idx === 0) { cor = '#f59e0b'; icone = '📦'; }
                        else { cor = '#3b82f6'; icone = idx; }
                    }
                    const icon = L.divIcon({ className: '', html: `<div style="background:${cor};color:#fff;width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:bold;font-size:12px;border:3px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,0.3)">${icone}</div>`, iconSize: [32, 32], iconAnchor: [16, 16] });
                    const enderecoCompleto = p.endereco_completo || `${p.rua || ''}, ${p.numero || ''} - ${p.bairro || ''}`;
                    const tipoLabel = idx === 0 ? '📦 COLETA' : `📍 ENTREGA ${idx}`;
                    L.marker([p.latitude, p.longitude], { icon }).bindPopup(`<strong>${tipoLabel}</strong><br/>${enderecoCompleto}`).addTo(markersLayer);
                });
                
                // NOVO: desenhar traçado entre os pontos.
                // Tenta usar OSRM (rota real pelas ruas); se falhar, cai em linha reta.
                if (pontosValidos.length >= 2) {
                    const coords = pontosValidos.map(p => `${p.longitude},${p.latitude}`).join(';');
                    const url = `https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson`;
                    
                    // Linha reta como fallback imediato (aparece rápido enquanto rota real carrega)
                    const linhaReta = L.polyline(
                        pontosValidos.map(p => [p.latitude, p.longitude]),
                        { color: '#7c3aed', weight: 3, opacity: 0.5, dashArray: '8, 10' }
                    ).addTo(markersLayer);
                    
                    fetch(url)
                        .then(r => r.ok ? r.json() : null)
                        .then(data => {
                            if (!data || !data.routes?.[0]?.geometry?.coordinates) return;
                            // Remove a linha reta e desenha a rota real
                            markersLayer.removeLayer(linhaReta);
                            const coordsRota = data.routes[0].geometry.coordinates.map(c => [c[1], c[0]]);
                            L.polyline(coordsRota, { color: '#7c3aed', weight: 5, opacity: 0.85 }).addTo(markersLayer);
                        })
                        .catch(() => { /* mantém a linha reta se o OSRM falhar */ });
                }
                
                if (pontosValidos.length > 0) { const bounds = L.latLngBounds(pontosValidos.map(p => [p.latitude, p.longitude])); map.fitBounds(bounds, { padding: [50, 50] }); }
                setTimeout(() => map.invalidateSize(), 50);
            }, [pontos, tipo]);
            
            useEffect(() => {
                const observer = new IntersectionObserver((entries) => { entries.forEach(entry => { if (entry.isIntersecting && mapInstanceRef.current) setTimeout(() => mapInstanceRef.current.invalidateSize(), 100); }); }, { threshold: 0.1 });
                if (mapRef.current) observer.observe(mapRef.current);
                return () => observer.disconnect();
            }, []);
            
            return <div ref={mapRef} className="rounded-xl shadow-lg" style={{ height, minHeight: '300px', width: '100%' }} />;
        };
        
        // ============ Componente de Ajuste com Google Maps — toggle Mapa/Satélite 3D ============
        const MapaAjustavelGoogle = ({ latitude, longitude, onPosicaoMudou, zoom = 18 }) => {
            const mapRef = useRef(null);
            const mapInstanceRef = useRef(null);
            const markerRef = useRef(null);
            const [tipoMapa, setTipoMapa] = useState('satellite'); // 'roadmap' | 'satellite'
            const [googleCarregado, setGoogleCarregado] = useState(!!(typeof window !== 'undefined' && window.google?.maps));
            
            // Aguardar Google Maps carregar (script é defer no <head>)
            useEffect(() => {
                if (googleCarregado) return;
                let tentativas = 0;
                const interval = setInterval(() => {
                    tentativas++;
                    if (window.google?.maps) {
                        setGoogleCarregado(true);
                        clearInterval(interval);
                    } else if (tentativas > 50) {
                        // 10s sem carregar — desiste
                        clearInterval(interval);
                    }
                }, 200);
                return () => clearInterval(interval);
            }, [googleCarregado]);
            
            // Inicializar o mapa quando o Google estiver carregado
            useEffect(() => {
                if (!googleCarregado || !mapRef.current) return;
                if (mapInstanceRef.current) return; // já inicializado
                
                const center = { lat: parseFloat(latitude), lng: parseFloat(longitude) };
                const map = new window.google.maps.Map(mapRef.current, {
                    center,
                    zoom,
                    mapTypeId: tipoMapa === 'satellite' ? 'hybrid' : 'roadmap',
                    tilt: tipoMapa === 'satellite' ? 45 : 0,
                    heading: 0,
                    mapTypeControl: false,
                    streetViewControl: false,
                    fullscreenControl: false,
                    zoomControl: true,
                    gestureHandling: 'greedy'
                });
                
                const marker = new window.google.maps.Marker({
                    position: center,
                    map,
                    draggable: true,
                    animation: window.google.maps.Animation.DROP,
                    title: 'Arraste para ajustar'
                });
                
                marker.addListener('dragend', (e) => {
                    onPosicaoMudou(e.latLng.lat(), e.latLng.lng());
                });
                
                map.addListener('click', (e) => {
                    marker.setPosition(e.latLng);
                    onPosicaoMudou(e.latLng.lat(), e.latLng.lng());
                });
                
                mapInstanceRef.current = map;
                markerRef.current = marker;
            }, [googleCarregado]);
            
            // Trocar tipo de mapa (roadmap vs satélite 3D)
            useEffect(() => {
                if (!mapInstanceRef.current) return;
                mapInstanceRef.current.setMapTypeId(tipoMapa === 'satellite' ? 'hybrid' : 'roadmap');
                mapInstanceRef.current.setTilt(tipoMapa === 'satellite' ? 45 : 0);
            }, [tipoMapa]);
            
            // Reagir a mudanças externas de latitude/longitude
            useEffect(() => {
                if (!mapInstanceRef.current || !markerRef.current) return;
                const pos = { lat: parseFloat(latitude), lng: parseFloat(longitude) };
                markerRef.current.setPosition(pos);
                mapInstanceRef.current.panTo(pos);
            }, [latitude, longitude]);
            
            if (!googleCarregado) {
                return (
                    <div className="w-full h-full flex items-center justify-center bg-gray-100 rounded-lg" style={{ minHeight: '400px' }}>
                        <div className="text-center">
                            <div className="text-4xl mb-2 animate-pulse">🗺️</div>
                            <p className="text-sm text-gray-600">Carregando Google Maps...</p>
                            <p className="text-xs text-gray-400 mt-1">Se persistir, verifique se a chave foi configurada</p>
                        </div>
                    </div>
                );
            }
            
            return (
                <div className="relative w-full h-full">
                    <div ref={mapRef} className="w-full h-full rounded-lg" style={{ minHeight: '400px' }} />
                    {/* Toggle Mapa / Satélite 3D */}
                    <div className="absolute top-3 left-3 bg-white rounded-lg shadow-lg overflow-hidden flex text-xs font-medium z-10">
                        <button
                            onClick={() => setTipoMapa('roadmap')}
                            className={`px-3 py-1.5 transition ${tipoMapa === 'roadmap' ? 'bg-blue-600 text-white' : 'bg-white text-gray-700 hover:bg-gray-100'}`}
                        >🗺️ Mapa</button>
                        <button
                            onClick={() => setTipoMapa('satellite')}
                            className={`px-3 py-1.5 transition ${tipoMapa === 'satellite' ? 'bg-blue-600 text-white' : 'bg-white text-gray-700 hover:bg-gray-100'}`}
                        >🛰️ Satélite 3D</button>
                    </div>
                </div>
            );
        };
        
        // ============ [LEGADO] Componente de Mapa Ajustável com Leaflet (mantido caso reverter) ============
        const MapaAjustavel = ({ latitude, longitude, onPosicaoMudou, zoom = 17 }) => {
            const mapRef = useRef(null);
            const mapInstanceRef = useRef(null);
            const markerRef = useRef(null);
            
            useEffect(() => {
                if (typeof L === 'undefined') return;
                const container = mapRef.current;
                if (!container) return;
                
                if (mapInstanceRef.current) {
                    mapInstanceRef.current.remove();
                    mapInstanceRef.current = null;
                }
                
                const map = L.map(container, { 
                    center: [latitude, longitude], 
                    zoom: zoom, 
                    zoomControl: true 
                });
                
                L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { 
                    maxZoom: 19, 
                    attribution: '© OpenStreetMap' 
                }).addTo(map);
                
                const icon = L.divIcon({ 
                    className: '', 
                    html: `<div style="position:relative;"><div style="background:#ef4444;color:#fff;width:40px;height:40px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);display:flex;align-items:center;justify-content:center;font-weight:bold;font-size:16px;border:3px solid #fff;box-shadow:0 4px 12px rgba(0,0,0,0.4)"><span style="transform:rotate(45deg);">📍</span></div></div>`, 
                    iconSize: [40, 48], 
                    iconAnchor: [20, 48] 
                });
                
                const marker = L.marker([latitude, longitude], { 
                    icon, 
                    draggable: true,
                    autoPan: true
                }).addTo(map);
                
                marker.on('dragend', function(e) {
                    const pos = e.target.getLatLng();
                    onPosicaoMudou(pos.lat, pos.lng);
                });
                
                map.on('click', function(e) {
                    marker.setLatLng(e.latlng);
                    onPosicaoMudou(e.latlng.lat, e.latlng.lng);
                });
                
                mapInstanceRef.current = map;
                markerRef.current = marker;
                
                setTimeout(() => {
                    if (mapInstanceRef.current) mapInstanceRef.current.invalidateSize();
                }, 100);
                
                return () => {
                    if (mapInstanceRef.current) {
                        mapInstanceRef.current.remove();
                        mapInstanceRef.current = null;
                    }
                };
            }, []);
            
            useEffect(() => {
                if (markerRef.current && mapInstanceRef.current) {
                    markerRef.current.setLatLng([latitude, longitude]);
                    mapInstanceRef.current.setView([latitude, longitude], mapInstanceRef.current.getZoom());
                }
            }, [latitude, longitude]);
            
            return <div ref={mapRef} className="w-full h-full rounded-lg" style={{ minHeight: '300px' }} />;
        };
        
        const Solicitacao = ({ cliente, token, onLogout, showToast }) => {
            const [abaAtiva, setAbaAtiva] = useState('nova');
            const [pontos, setPontos] = useState([]);
            const [termoBusca, setTermoBusca] = useState('');
            const [sugestoes, setSugestoes] = useState([]);
            const [buscando, setBuscando] = useState(false);
            const [loading, setLoading] = useState(false);
            const [historico, setHistorico] = useState([]);
            const [mostrarHistorico, setMostrarHistorico] = useState(false);
            const [abaMobile, setAbaMobile] = useState('form');
            const [pontoEditando, setPontoEditando] = useState(null);
            const [dadosPonto, setDadosPonto] = useState({ observacao: '', telefone: '', procurar_por: '', numero_nota: '', codigo_finalizar: '', complemento: '' });
            const [corridasAtivas, setCorridasAtivas] = useState([]);
            const [corridaSelecionada, setCorridaSelecionada] = useState(null);
            const [detalheCorrida, setDetalheCorrida] = useState(null);
            const [corridasConcluidas, setCorridasConcluidas] = useState([]);
            const [filtroConcluidas, setFiltroConcluidas] = useState('todas');
            const [corridaExpandida, setCorridaExpandida] = useState(null);
            const [detalhesCorridaExpandida, setDetalhesCorridaExpandida] = useState(null);
            const [sincronizando, setSincronizando] = useState(false);
            const [sincronizandoHistorico, setSincronizandoHistorico] = useState(false);
            const [profissionais, setProfissionais] = useState([]);
            const [carregandoProfissionais, setCarregandoProfissionais] = useState(false);
            const [mapaKey, setMapaKey] = useState(0);
            
            // Estado para input de nota rápida após adicionar ponto
            const [pontoRecemAdicionado, setPontoRecemAdicionado] = useState(null);
            const [notaRapida, setNotaRapida] = useState('');
            const notaInputRef = useRef(null);
            
            // Estado para modal de fotos
            const [fotoModal, setFotoModal] = useState({ aberto: false, fotos: [], indice: 0 });
            
            // Estado para endereços salvos
            const [enderecosSalvos, setEnderecosSalvos] = useState([]);
            const [mostrarSalvos, setMostrarSalvos] = useState(false);
            const [modalSalvarEndereco, setModalSalvarEndereco] = useState({ aberto: false, ponto: null });
            const [apelidoSalvar, setApelidoSalvar] = useState('');
            const [complementoSalvar, setComplementoSalvar] = useState('');
            const [salvandoEndereco, setSalvandoEndereco] = useState(false);
            
            // ============ NOVO: Estados para modal de ajuste de mapa ============
            const [modalAjusteMapa, setModalAjusteMapa] = useState({
                aberto: false,
                sugestaoOriginal: null,
                latitude: null,
                longitude: null,
                etapa: 'ajustar'
            });
            const [posicaoAjustada, setPosicaoAjustada] = useState({ lat: null, lng: null });
            const [enderecoAjustado, setEnderecoAjustado] = useState(null);
            const [buscandoEnderecoReverso, setBuscandoEnderecoReverso] = useState(false);
            
            // NOVO: localização do usuário (geolocation) para centralizar o mapa na região de acesso
            const [localizacaoUsuario, setLocalizacaoUsuario] = useState(null);
            
            // NOVO: banner que pergunta se quer ajustar a posição após adicionar um ponto
            const [promptAjuste, setPromptAjuste] = useState({ aberto: false, pontoId: null });
            
            // NOVO: prompt inline pra quando o endereço escolhido não traz número (street_number)
            // Evita adicionar pontos "genéricos" que confundem o motoboy
            const [aguardandoNumero, setAguardandoNumero] = useState({ aberto: false, sugestao: null, numero: '' });
            
            const abrirFotoModal = (fotos, indice = 0) => {
                setFotoModal({ aberto: true, fotos, indice });
            };
            
            const fecharFotoModal = () => {
                setFotoModal({ aberto: false, fotos: [], indice: 0 });
            };
            
            const navegarFoto = (direcao) => {
                setFotoModal(prev => ({
                    ...prev,
                    indice: Math.max(0, Math.min(prev.fotos.length - 1, prev.indice + direcao))
                }));
            };
            
            const [config, setConfig] = useState({
                numero_pedido: '', centro_custo: cliente.centro_custo_padrao || '', usuario_solicitante: cliente.nome,
                data_retirada: '', hora_retirada: '', forma_pagamento: cliente.forma_pagamento_padrao || 'F',
                ponto_receber: '', retorno: false, obs_retorno: '', ordenar: false, 
                codigo_profissional: '',
                sem_profissional: false
            });
            
            useEffect(() => { if (abaAtiva === 'nova' || abaAtiva === 'acompanhar') setMapaKey(prev => prev + 1); }, [abaAtiva, corridaSelecionada]);
            useEffect(() => { carregarProfissionais(); }, []);
            
            // NOVO: pedir geolocalização ao montar — centraliza mapa na região do usuário
            useEffect(() => {
                if (!navigator.geolocation) return;
                navigator.geolocation.getCurrentPosition(
                    (pos) => {
                        setLocalizacaoUsuario({ lat: pos.coords.latitude, lng: pos.coords.longitude });
                    },
                    (err) => {
                        // Falha silenciosa — usa o centro padrão (Salvador)
                        console.log('Geolocalização indisponível:', err.message);
                    },
                    { timeout: 8000, maximumAge: 300000, enableHighAccuracy: false }
                );
            }, []);
            
            // NOVO: carregar Google Maps JS dinamicamente usando chave do backend
            // Evita hardcode de chave no HTML e permite rotação via env var no Railway
            useEffect(() => {
                // Já carregado? Nada a fazer.
                if (window.google?.maps) return;
                // Já existe um <script> de google maps injetado? Aguarda ele carregar.
                if (document.querySelector('script[data-tutts-maps-loader]')) return;
                
                (async () => {
                    try {
                        const resp = await fetch(`${API_URL}/api/solicitacao/maps-key`, {
                            headers: { 'Authorization': `Bearer ${token}` }
                        });
                        if (!resp.ok) {
                            console.error('❌ Falha ao obter chave do Google Maps:', resp.status);
                            return;
                        }
                        const { key } = await resp.json();
                        if (!key) return;
                        
                        const script = document.createElement('script');
                        script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&libraries=places,geometry&v=weekly`;
                        script.async = true;
                        script.defer = true;
                        script.setAttribute('data-tutts-maps-loader', '1');
                        script.onload = () => console.log('✅ Google Maps JS carregado');
                        script.onerror = () => console.error('❌ Erro ao carregar Google Maps JS — verifique a chave');
                        document.head.appendChild(script);
                    } catch (err) {
                        console.error('❌ Erro no loader do Google Maps:', err);
                    }
                })();
            }, [token]);
            
            // Foco no input de nota quando ponto é adicionado
            useEffect(() => {
                if (pontoRecemAdicionado !== null && notaInputRef.current) {
                    notaInputRef.current.focus();
                }
            }, [pontoRecemAdicionado]);
            
            const carregarProfissionais = async () => {
                setCarregandoProfissionais(true);
                try {
                    const resp = await fetch(`${API_URL}/api/solicitacao/profissionais`, { headers: { 'Authorization': `Bearer ${token}` } });
                    if (resp.ok) { const data = await resp.json(); setProfissionais(data.profissionais || []); }
                } catch (err) { console.error('Erro ao carregar profissionais:', err); }
                setCarregandoProfissionais(false);
            };
            
            useEffect(() => { 
                if (cliente.endereco_partida_padrao) setPontos([{ id: Date.now(), ...cliente.endereco_partida_padrao, isPartida: true }]); 
                carregarHistorico(); 
                carregarCorridasAtivas(); 
            }, []);
            
            useEffect(() => {
                if (abaAtiva !== 'acompanhar') return;
                
                // Carregar imediatamente ao entrar na aba
                carregarCorridasAtivas();
                
                // Sincronizar com Tutts a cada 30 segundos
                const intervalSync = setInterval(async () => {
                    try {
                        const resp = await fetch(`${API_URL}/api/solicitacao/sincronizar`, { 
                            method: 'POST', 
                            headers: { 'Authorization': `Bearer ${token}` } 
                        });
                        if (resp.ok) {
                            // Recarregar dados após sincronização
                            carregarCorridasAtivas();
                            carregarConcluidas();
                            if (corridaSelecionada) carregarDetalheCorrida(corridaSelecionada);
                        }
                    } catch (err) {}
                }, 30000);
                
                // Atualizar lista local a cada 10 segundos
                const intervalLocal = setInterval(() => { 
                    carregarCorridasAtivas(); 
                    if (corridaSelecionada) carregarDetalheCorrida(corridaSelecionada); 
                }, 10000);
                
                return () => {
                    clearInterval(intervalSync);
                    clearInterval(intervalLocal);
                };
            }, [abaAtiva, corridaSelecionada]);
            
            const carregarHistorico = async () => { try { const resp = await fetch(`${API_URL}/api/solicitacao/historico?limite=20`, { headers: { 'Authorization': `Bearer ${token}` } }); if (resp.ok) { const data = await resp.json(); setHistorico(data.solicitacoes || []); } } catch (err) {} };
            const carregarCorridasAtivas = async () => { try { const resp = await fetch(`${API_URL}/api/solicitacao/historico?limite=50`, { headers: { 'Authorization': `Bearer ${token}` } }); if (resp.ok) { const data = await resp.json(); setCorridasAtivas((data.solicitacoes || []).filter(s => ['enviado', 'aceito', 'em_andamento'].includes(s.status))); } } catch (err) {} };
            const carregarConcluidas = async () => { try { const resp = await fetch(`${API_URL}/api/solicitacao/historico?limite=100`, { headers: { 'Authorization': `Bearer ${token}` } }); if (resp.ok) { const data = await resp.json(); setCorridasConcluidas((data.solicitacoes || []).filter(s => ['finalizado', 'cancelado'].includes(s.status))); } } catch (err) {} };
            
            // Função para sincronizar histórico (recuperar dados de corridas antigas)
            const sincronizarHistorico = async () => {
                if (sincronizandoHistorico) return;
                setSincronizandoHistorico(true);
                try {
                    const resp = await fetch(`${API_URL}/api/solicitacao/sincronizar-historico`, {
                        method: 'POST',
                        headers: { 
                            'Authorization': `Bearer ${token}`,
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({ limite: 100, apenasIncompletas: false })
                    });
                    if (resp.ok) {
                        const data = await resp.json();
                        alert(`✅ Sincronização concluída!\n\n${data.atualizadas} corridas atualizadas de ${data.total_verificadas} verificadas.`);
                        // Recarregar a lista
                        carregarConcluidas();
                    } else {
                        const err = await resp.json();
                        alert('❌ Erro: ' + (err.error || 'Falha na sincronização'));
                    }
                } catch (err) {
                    alert('❌ Erro de conexão');
                } finally {
                    setSincronizandoHistorico(false);
                }
            };
            const carregarDetalheCorrida = async (id) => { 
                try { 
                    const resp = await fetch(`${API_URL}/api/solicitacao/corrida/${id}`, { headers: { 'Authorization': `Bearer ${token}` } }); 
                    if (resp.ok) {
                        const data = await resp.json();
                        setDetalheCorrida(data);
                        // Se a corrida foi finalizada ou cancelada, limpar seleção e atualizar listas
                        if (['finalizado', 'cancelado'].includes(data.status)) {
                            showToast(data.status === 'finalizado' ? '🏁 Corrida finalizada!' : '❌ Corrida cancelada', 'info');
                            setCorridaSelecionada(null);
                            setDetalheCorrida(null);
                            carregarCorridasAtivas();
                            carregarConcluidas();
                        }
                    }
                } catch (err) {} 
            };
            const selecionarCorrida = (id) => { setCorridaSelecionada(id); carregarDetalheCorrida(id); };
            const copiarLinkRastreio = (os) => { navigator.clipboard.writeText(`${SITE_URL}/rastrear.html?os=${os}`).then(() => showToast('✅ Link copiado!', 'success')); };
            const compartilharWhatsApp = (os) => { window.open(`https://wa.me/?text=${encodeURIComponent(`🏍️ Acompanhe sua entrega:\n${SITE_URL}/rastrear.html?os=${os}`)}`, '_blank'); };
            
            // Função para expandir/colapsar corrida concluída
            const toggleExpandirCorrida = async (id) => {
                if (corridaExpandida === id) {
                    setCorridaExpandida(null);
                    setDetalhesCorridaExpandida(null);
                } else {
                    setCorridaExpandida(id);
                    setDetalhesCorridaExpandida(null);
                    try {
                        const resp = await fetch(`${API_URL}/api/solicitacao/corrida/${id}`, { headers: { 'Authorization': `Bearer ${token}` } });
                        if (resp.ok) {
                            const data = await resp.json();
                            setDetalhesCorridaExpandida(data);
                        }
                    } catch (err) {
                        console.error('Erro ao carregar detalhes:', err);
                    }
                }
            };
            
            const cancelarCorrida = async (id) => {
                if (!confirm('Tem certeza que deseja CANCELAR esta corrida?')) return;
                try {
                    const resp = await fetch(`${API_URL}/api/solicitacao/corrida/${id}/cancelar`, { method: 'PATCH', headers: { 'Authorization': `Bearer ${token}` } });
                    const data = await resp.json();
                    if (resp.ok) { showToast(data.cancelou_tutts ? '✅ Corrida cancelada!' : '❌ Corrida marcada como cancelada', 'success'); carregarCorridasAtivas(); carregarConcluidas(); setCorridaSelecionada(null); setDetalheCorrida(null); }
                    else showToast(data.error || 'Erro ao cancelar', 'error');
                } catch (err) { showToast('Erro ao cancelar', 'error'); }
            };
            
            const sincronizarStatus = async () => {
                setSincronizando(true);
                try {
                    const resp = await fetch(`${API_URL}/api/solicitacao/sincronizar`, { method: 'POST', headers: { 'Authorization': `Bearer ${token}` } });
                    const data = await resp.json();
                    if (resp.ok) {
                        if (data.atualizadas > 0) { showToast(`🔄 ${data.atualizadas} atualizada(s)`, 'success'); carregarCorridasAtivas(); carregarConcluidas(); if (corridaSelecionada) carregarDetalheCorrida(corridaSelecionada); }
                        else showToast('✅ Tudo sincronizado!', 'info');
                    } else showToast(data.error || 'Erro', 'error');
                } catch (err) { showToast('Erro', 'error'); }
                setSincronizando(false);
            };
            
            const buscarEndereco = async () => {
                if (!termoBusca || termoBusca.length < 3) { showToast('Digite pelo menos 3 caracteres', 'warning'); return; }
                setBuscando(true);
                try { const resp = await fetch(`${API_URL}/api/geocode/google?endereco=${encodeURIComponent(termoBusca)}`); if (resp.ok) { const data = await resp.json(); if (data.results?.length > 0) setSugestoes(data.results); else showToast('Nenhum endereço', 'warning'); } }
                catch (err) { showToast('Erro', 'error'); }
                setBuscando(false);
            };
            
            // ============ NOVO: Funções para ajuste de mapa ============
            const buscarEnderecoReverso = async (lat, lng) => {
                setBuscandoEnderecoReverso(true);
                try {
                    const resp = await fetch(`${API_URL}/api/geocode/google?endereco=${lat},${lng}`);
                    if (resp.ok) {
                        const data = await resp.json();
                        if (data.results?.length > 0) {
                            setEnderecoAjustado(data.results[0]);
                            return data.results[0];
                        }
                    }
                    showToast('Não foi possível obter o endereço', 'warning');
                    return null;
                } catch (err) {
                    showToast('Erro ao buscar endereço', 'error');
                    return null;
                } finally {
                    setBuscandoEnderecoReverso(false);
                }
            };
            
            const abrirModalAjusteMapa = (sugestao) => {
                setModalAjusteMapa({
                    aberto: true,
                    sugestaoOriginal: sugestao,
                    latitude: sugestao.latitude,
                    longitude: sugestao.longitude,
                    etapa: 'ajustar'
                });
                setPosicaoAjustada({ lat: sugestao.latitude, lng: sugestao.longitude });
                setEnderecoAjustado(null);
            };
            
            const onPosicaoMudou = (lat, lng) => {
                setPosicaoAjustada({ lat, lng });
            };
            
            const confirmarPosicaoMapa = async () => {
                const endereco = await buscarEnderecoReverso(posicaoAjustada.lat, posicaoAjustada.lng);
                if (endereco) {
                    setModalAjusteMapa(prev => ({ ...prev, etapa: 'confirmar' }));
                }
            };
            
            const usarEnderecoAjustado = () => {
                if (!enderecoAjustado) return;
                
                const sug = enderecoAjustado;
                const comp = sug.componentes || [];
                const get = (t) => comp.find(c => c.types?.includes(t))?.long_name || '';
                const getS = (t) => comp.find(c => c.types?.includes(t))?.short_name || '';
                
                // NOVO FLUXO: o ponto já foi adicionado. Agora só atualizamos com a posição ajustada.
                const pontoId = modalAjusteMapa.pontoId;
                if (!pontoId) {
                    showToast('❌ Erro: ponto não identificado', 'error');
                    return;
                }
                
                setPontos(prev => prev.map(p => {
                    if (p.id !== pontoId) return p;
                    return {
                        ...p,
                        endereco_completo: sug.endereco || p.endereco_completo,
                        rua: get('route') || p.rua,
                        numero: get('street_number') || p.numero,
                        bairro: get('sublocality_level_1') || get('sublocality') || p.bairro,
                        cidade: get('administrative_area_level_2') || get('locality') || p.cidade,
                        uf: getS('administrative_area_level_1') || p.uf,
                        cep: get('postal_code') || p.cep,
                        latitude: posicaoAjustada.lat,
                        longitude: posicaoAjustada.lng,
                        ajustado_manualmente: true
                    };
                }));
                
                fecharModalAjusteMapa();
                showToast('✅ Posição ajustada com sucesso!', 'success');
            };
            
            const voltarParaAjustar = () => {
                setModalAjusteMapa(prev => ({ ...prev, etapa: 'ajustar' }));
                setEnderecoAjustado(null);
            };
            
            const fecharModalAjusteMapa = () => {
                setModalAjusteMapa({ aberto: false, sugestaoOriginal: null, latitude: null, longitude: null, pontoId: null, etapa: 'ajustar' });
                setEnderecoAjustado(null);
                setPosicaoAjustada({ lat: null, lng: null });
            };
            
            // Buscar endereços salvos
            const buscarEnderecosSalvos = async (termo = '') => {
                try {
                    const url = termo ? `${API_URL}/api/solicitacao/enderecos-salvos/buscar?q=${encodeURIComponent(termo)}` : `${API_URL}/api/solicitacao/enderecos-salvos/buscar`;
                    const resp = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
                    if (resp.ok) {
                        const data = await resp.json();
                        setEnderecosSalvos(data);
                        setMostrarSalvos(data.length > 0);
                    }
                } catch (err) {
                    console.error('Erro ao buscar salvos:', err);
                }
            };
            
            // Buscar salvos quando digita
            useEffect(() => {
                if (termoBusca.length >= 2) {
                    buscarEnderecosSalvos(termoBusca);
                } else if (termoBusca.length === 0) {
                    setMostrarSalvos(false);
                    setEnderecosSalvos([]);
                }
            }, [termoBusca]);
            
            // NOVO: autocomplete Google com debounce 400ms — economiza requisições
            // Dispara após 400ms parado, mínimo 3 caracteres. Cancela se o usuário continua digitando.
            useEffect(() => {
                if (!termoBusca || termoBusca.length < 3) {
                    setSugestoes([]);
                    return;
                }
                const timer = setTimeout(async () => {
                    setBuscando(true);
                    try {
                        const resp = await fetch(`${API_URL}/api/geocode/google?endereco=${encodeURIComponent(termoBusca)}`);
                        if (resp.ok) {
                            const data = await resp.json();
                            setSugestoes(data.results?.length > 0 ? data.results : []);
                        }
                    } catch (err) {
                        console.error('Erro autocomplete Google:', err);
                    }
                    setBuscando(false);
                }, 400);
                return () => clearTimeout(timer);
            }, [termoBusca]);
            
            // Adicionar ponto de endereço salvo
            const adicionarPontoSalvo = async (endereco) => {
                if (pontos.length >= 2) { showToast('Este fluxo permite apenas 1 ponto de entrega', 'error'); return; }
                
                const novoId = Date.now();
                const novoPonto = { 
                    id: novoId, 
                    endereco_completo: endereco.endereco_completo || `${endereco.rua}, ${endereco.numero} - ${endereco.bairro}, ${endereco.cidade}`,
                    rua: endereco.rua, 
                    numero: endereco.numero, 
                    complemento: endereco.complemento || '',
                    bairro: endereco.bairro, 
                    cidade: endereco.cidade, 
                    uf: endereco.uf, 
                    cep: endereco.cep, 
                    latitude: parseFloat(endereco.latitude), 
                    longitude: parseFloat(endereco.longitude), 
                    observacao: '', 
                    telefone: '', 
                    procurar_por: '', 
                    numero_nota: '', 
                    codigo_finalizar: '',
                    endereco_salvo_id: endereco.id,
                    apelido_salvo: endereco.apelido
                };
                
                const novosPontos = [...pontos, novoPonto];
                setPontos(novosPontos);
                setTermoBusca(''); 
                setSugestoes([]);
                setMostrarSalvos(false);
                setEnderecosSalvos([]);
                
                // Incrementar uso
                try {
                    await fetch(`${API_URL}/api/solicitacao/enderecos-salvos/${endereco.id}/usar`, {
                        method: 'PATCH',
                        headers: { 'Authorization': `Bearer ${token}` }
                    });
                } catch (err) {}
                
                // Se for ponto de entrega, mostrar input de nota
                if (novosPontos.length > 1) {
                    setPontoRecemAdicionado(novoId);
                    setNotaRapida('');
                }
                
                showToast(`✅ "${endereco.apelido}" adicionado`, 'success');
            };
            
            // Salvar endereço
            const salvarEndereco = async () => {
                if (!apelidoSalvar.trim()) { showToast('Digite um apelido', 'warning'); return; }
                if (!modalSalvarEndereco.ponto) return;
                
                setSalvandoEndereco(true);
                const p = modalSalvarEndereco.ponto;
                
                // Tentar extrair cidade do endereço completo se não tiver
                let cidade = p.cidade;
                if (!cidade && p.endereco_completo) {
                    // Formato típico: "Rua X, 123 - Bairro, Cidade - UF, CEP"
                    const partes = p.endereco_completo.split(',');
                    if (partes.length >= 3) {
                        // Tentar pegar a cidade (geralmente após o bairro)
                        const cidadeUF = partes[partes.length - 2]?.trim();
                        if (cidadeUF) {
                            cidade = cidadeUF.split('-')[0]?.trim() || cidadeUF;
                        }
                    }
                }
                
                // Usar o complemento editado no modal ou o original do ponto
                const complementoFinal = complementoSalvar || p.complemento || '';
                
                try {
                    const resp = await fetch(`${API_URL}/api/solicitacao/enderecos-salvos`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                        body: JSON.stringify({
                            apelido: apelidoSalvar.trim(),
                            rua: p.rua,
                            numero: p.numero,
                            complemento: complementoFinal,
                            bairro: p.bairro,
                            cidade: cidade || 'Não informada',
                            uf: p.uf,
                            cep: p.cep,
                            latitude: p.latitude,
                            longitude: p.longitude,
                            endereco_completo: p.endereco_completo
                        })
                    });
                    
                    const data = await resp.json();
                    if (resp.ok) {
                        showToast(`💾 "${apelidoSalvar}" salvo!`, 'success');
                        setModalSalvarEndereco({ aberto: false, ponto: null });
                        setApelidoSalvar('');
                        setComplementoSalvar('');
                        // Atualizar o complemento no ponto atual também
                        if (complementoFinal && complementoFinal !== p.complemento) {
                            setPontos(prev => prev.map(ponto => 
                                ponto.id === p.id ? { ...ponto, complemento: complementoFinal } : ponto
                            ));
                        }
                    } else {
                        showToast(data.error || 'Erro ao salvar', 'error');
                    }
                } catch (err) {
                    showToast('Erro ao salvar', 'error');
                }
                setSalvandoEndereco(false);
            };
            
            // Helper: cria o objeto ponto a partir da sugestão do Google.
            // Aceita um `numeroOverride` pra quando o usuário preenche manualmente o número.
            const criarPontoDeSugestao = (sug, numeroOverride = null) => {
                const comp = sug.componentes || [];
                const get = (t) => comp.find(c => c.types?.includes(t))?.long_name || '';
                const getS = (t) => comp.find(c => c.types?.includes(t))?.short_name || '';
                const numeroFinal = numeroOverride !== null ? numeroOverride : get('street_number');
                // Se o usuário informou um número manual, concatena no endereço completo
                let enderecoFinal = sug.endereco || '';
                if (numeroOverride && numeroOverride !== 'S/N' && !get('street_number')) {
                    // Insere o número após a rua no endereço formatado
                    const rua = get('route');
                    if (rua && enderecoFinal.startsWith(rua)) {
                        enderecoFinal = `${rua}, ${numeroOverride}${enderecoFinal.substring(rua.length)}`;
                    }
                }
                return {
                    id: Date.now(),
                    endereco_completo: enderecoFinal,
                    rua: get('route'),
                    numero: numeroFinal,
                    complemento: '',
                    bairro: get('sublocality_level_1') || get('sublocality'),
                    cidade: get('administrative_area_level_2') || get('locality'),
                    uf: getS('administrative_area_level_1'),
                    cep: get('postal_code'),
                    latitude: sug.latitude,
                    longitude: sug.longitude,
                    observacao: '',
                    telefone: '',
                    procurar_por: '',
                    numero_nota: '',
                    codigo_finalizar: '',
                    numero_manual: !!numeroOverride && !get('street_number')
                };
            };
            
            // Finaliza a adição do ponto (efeitos colaterais: toast, prompt de ajuste, nota rápida)
            const finalizarAdicaoPonto = (novoPonto) => {
                const novosPontos = [...pontos, novoPonto];
                setPontos(novosPontos);
                setTermoBusca('');
                setSugestoes([]);
                setAguardandoNumero({ aberto: false, sugestao: null, numero: '' });
                
                // Se for ponto de entrega (não o primeiro), mostrar input de nota
                if (novosPontos.length > 1) {
                    setPontoRecemAdicionado(novoPonto.id);
                    setNotaRapida('');
                }
                
                // Perguntar se quer ajustar a posição no mapa
                setPromptAjuste({ aberto: true, pontoId: novoPonto.id });
                
                showToast('✅ Adicionado', 'success');
            };
            
            const adicionarPonto = (sug) => {
                if (pontos.length >= 2) { showToast('Este fluxo permite apenas 1 ponto de entrega', 'error'); return; }
                const comp = sug.componentes || [];
                const temNumero = !!comp.find(c => c.types?.includes('street_number'));
                
                // Se o Google não retornou número, pedir pro usuário informar antes de adicionar
                if (!temNumero) {
                    setAguardandoNumero({ aberto: true, sugestao: sug, numero: '' });
                    return;
                }
                
                finalizarAdicaoPonto(criarPontoDeSugestao(sug));
            };
            
            // Confirmar número digitado manualmente e adicionar o ponto
            const confirmarNumeroManual = () => {
                const num = (aguardandoNumero.numero || '').trim();
                if (!num) { showToast('Digite o número ou marque S/N', 'warning'); return; }
                finalizarAdicaoPonto(criarPontoDeSugestao(aguardandoNumero.sugestao, num));
            };
            
            // Marcar como S/N (sem número) — ainda assim adiciona o ponto
            const marcarSemNumero = () => {
                finalizarAdicaoPonto(criarPontoDeSugestao(aguardandoNumero.sugestao, 'S/N'));
            };
            
            // Cancelar — volta pras sugestões
            const cancelarPromptNumero = () => {
                setAguardandoNumero({ aberto: false, sugestao: null, numero: '' });
            };
            
            // NOVO: aceitar o ajuste — abre o modal Google Maps com o ponto recém-adicionado
            const aceitarAjusteMapa = () => {
                const ponto = pontos.find(p => p.id === promptAjuste.pontoId);
                if (!ponto) { setPromptAjuste({ aberto: false, pontoId: null }); return; }
                setModalAjusteMapa({
                    aberto: true,
                    sugestaoOriginal: { endereco: ponto.endereco_completo, componentes: [] },
                    latitude: parseFloat(ponto.latitude),
                    longitude: parseFloat(ponto.longitude),
                    pontoId: ponto.id,
                    etapa: 'ajustar'
                });
                setPosicaoAjustada({ lat: parseFloat(ponto.latitude), lng: parseFloat(ponto.longitude) });
                setEnderecoAjustado(null);
                setPromptAjuste({ aberto: false, pontoId: null });
            };
            
            // NOVO: recusar o ajuste — fecha o banner
            const recusarAjusteMapa = () => {
                setPromptAjuste({ aberto: false, pontoId: null });
            };
            
            // Salvar nota rápida
            const salvarNotaRapida = () => {
                if (pontoRecemAdicionado && notaRapida.trim()) {
                    setPontos(prev => prev.map(p => 
                        p.id === pontoRecemAdicionado 
                            ? { ...p, numero_nota: notaRapida.trim() } 
                            : p
                    ));
                    showToast('🏷️ Nota adicionada!', 'success');
                }
                setPontoRecemAdicionado(null);
                setNotaRapida('');
            };
            
            // Pular nota rápida
            const pularNotaRapida = () => {
                setPontoRecemAdicionado(null);
                setNotaRapida('');
            };
            
            const removerPonto = (id) => {
                setPontos(pontos.filter(p => p.id !== id));
                if (pontoRecemAdicionado === id) {
                    setPontoRecemAdicionado(null);
                    setNotaRapida('');
                }
            };
            
            const moverPonto = (idx, dir) => { const lista = [...pontos]; const n = idx + dir; if (n >= 0 && n < lista.length) { [lista[idx], lista[n]] = [lista[n], lista[idx]]; setPontos(lista); } };
            
            const abrirEdicaoPonto = (idx) => { 
                const p = pontos[idx]; 
                setDadosPonto({ 
                    observacao: p.observacao || '', 
                    telefone: p.telefone || '', 
                    procurar_por: p.procurar_por || '', 
                    numero_nota: p.numero_nota || '', 
                    codigo_finalizar: p.codigo_finalizar || '',
                    complemento: p.complemento || ''
                }); 
                setPontoEditando(idx);
                // Fechar input de nota rápida se estiver aberto
                setPontoRecemAdicionado(null);
                setNotaRapida('');
            };
            
            const salvarEdicaoPonto = () => { const n = [...pontos]; n[pontoEditando] = { ...n[pontoEditando], ...dadosPonto }; setPontos(n); setPontoEditando(null); showToast('✅ Salvo', 'success'); };
            const salvarPartidaPadrao = async () => { if (pontos.length === 0) return; try { await fetch(`${API_URL}/api/solicitacao/configuracoes`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }, body: JSON.stringify({ endereco_partida_padrao: pontos[0] }) }); showToast('✅ Salvo!', 'success'); } catch {} };
            const limpar = () => { if (cliente.endereco_partida_padrao) setPontos([{ id: Date.now(), ...cliente.endereco_partida_padrao, isPartida: true }]); else setPontos([]); setSugestoes([]); setTermoBusca(''); setPontoRecemAdicionado(null); setNotaRapida(''); };
            
            const enviarSolicitacao = async () => {
                if (pontos.length < 2) { showToast('Mínimo 2 pontos', 'error'); return; }
                if (config.ordenar && pontos.length > 20) { showToast('Ordenação: máx 20 pts', 'warning'); return; }
                
                // Fechar input de nota rápida antes de enviar
                if (pontoRecemAdicionado && notaRapida.trim()) {
                    setPontos(prev => prev.map(p => p.id === pontoRecemAdicionado ? { ...p, numero_nota: notaRapida.trim() } : p));
                }
                setPontoRecemAdicionado(null);
                setNotaRapida('');
                
                setLoading(true);
                try {
                    const dataRet = config.data_retirada && config.hora_retirada ? `${config.data_retirada} ${config.hora_retirada}:00` : '';
                    
                    // Buscar dados do profissional selecionado
                    const profSelecionado = config.codigo_profissional ? profissionais.find(p => p.codigo === config.codigo_profissional) : null;
                    
                    const payload = { 
                        numero_pedido: config.numero_pedido, 
                        centro_custo: config.centro_custo, 
                        usuario_solicitante: config.usuario_solicitante, 
                        data_retirada: dataRet, 
                        forma_pagamento: config.forma_pagamento, 
                        ponto_receber: config.ponto_receber ? parseInt(config.ponto_receber) : null, 
                        retorno: config.retorno, 
                        obs_retorno: config.obs_retorno, 
                        ordenar: config.ordenar, 
                        codigo_profissional: config.codigo_profissional,
                        // Dados do profissional selecionado
                        profissional_nome: profSelecionado?.nome || null,
                        profissional_foto: profSelecionado?.foto || null,
                        profissional_telefone: profSelecionado?.telefone || null,
                        profissional_placa: profSelecionado?.placa || null,
                        sem_profissional: config.sem_profissional, 
                        pontos: pontos.map(p => ({ 
                            rua: p.rua || '', 
                            numero: p.numero || '', 
                            complemento: p.complemento || '', 
                            bairro: p.bairro || '', 
                            cidade: p.cidade || '', 
                            uf: p.uf || '', 
                            cep: p.cep || '', 
                            latitude: p.latitude, 
                            longitude: p.longitude, 
                            observacao: p.observacao || '', 
                            telefone: p.telefone || '', 
                            procurar_por: p.procurar_por || '', 
                            numero_nota: p.numero_nota || '', 
                            codigo_finalizar: p.codigo_finalizar || '', 
                            endereco_completo: p.endereco_completo || '' 
                        })) 
                    };
                    const resp = await fetch(`${API_URL}/api/solicitacao/corrida`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }, body: JSON.stringify(payload) });
                    const data = await resp.json();
                    if (resp.ok) { 
                        const motoboy = config.codigo_profissional ? profissionais.find(p => p.codigo === config.codigo_profissional)?.nome : null; 
                        showToast(`✅ OS: ${data.os_numero}${motoboy ? ` → ${motoboy}` : ''}${data.modo_teste ? ' (TESTE)' : ''}`, 'success'); 
                        limpar(); 
                        setConfig(prev => ({ ...prev, codigo_profissional: '' })); 
                        carregarHistorico(); 
                        carregarCorridasAtivas(); 
                    }
                    else showToast(data.error || 'Erro', 'error');
                } catch { showToast('Erro', 'error'); }
                setLoading(false);
            };
            
            // Mapeamentos de status
            const statusCores = { enviado: 'bg-yellow-100 text-yellow-800 border-yellow-300', aceito: 'bg-blue-100 text-blue-800 border-blue-300', em_andamento: 'bg-purple-100 text-purple-800 border-purple-300', finalizado: 'bg-green-100 text-green-800 border-green-300', cancelado: 'bg-red-100 text-red-800 border-red-300', erro: 'bg-red-100 text-red-800 border-red-300' };
            const statusNomes = { enviado: 'Aguardando', aceito: 'Aceito', em_andamento: 'Em Andamento', finalizado: 'Finalizado', cancelado: 'Cancelado', erro: 'Erro' };
            const statusIcons = { enviado: '⏳', aceito: '✅', em_andamento: '🏍️', finalizado: '🏁', cancelado: '❌', erro: '⚠️' };
            const statusPontoCores = { pendente: 'bg-gray-50 border-gray-200', chegou: 'bg-blue-50 border-blue-300', coletado: 'bg-yellow-50 border-yellow-300', finalizado: 'bg-green-50 border-green-300' };
            const statusPontoNomes = { pendente: 'Pendente', chegou: 'Chegou', coletado: 'Coletado', finalizado: 'Finalizado' };
            const statusPontoIcons = { pendente: '⚪', chegou: '🔵', coletado: '🟡', finalizado: '✅' };
            
            const formatarData = (d) => d ? new Date(d).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
            const formatarHora = (d) => d ? new Date(d).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '';
            const contarPontos = (corrida) => { const total = corrida.total_pontos || 0; return { coletas: 1, entregas: Math.max(0, total - 1) }; };
            
            // Analisa o estado completo da corrida e retorna uma mensagem descritiva.
            // Combina o status principal com os eventos dos pontos pra dar uma descrição precisa
            // do que o motoboy está fazendo agora.
            const analisarEstadoCorrida = (corrida) => {
                // Estados diretos do status principal
                if (corrida.status === 'enviado') {
                    return { icone: '⏳', texto: 'Aguardando aceite do motoboy', cor: 'bg-gray-100 text-gray-700 border-gray-300' };
                }
                if (corrida.status === 'erro') {
                    return { icone: '❌', texto: 'Erro ao criar corrida', cor: 'bg-red-100 text-red-700 border-red-300' };
                }
                if (corrida.status === 'cancelado') {
                    return { icone: '✕', texto: 'Cancelado', cor: 'bg-red-100 text-red-700 border-red-300' };
                }
                if (corrida.status === 'finalizado') {
                    return { icone: '✅', texto: 'Finalizado', cor: 'bg-green-100 text-green-700 border-green-300' };
                }
                
                // Para 'aceito' e 'em_andamento', olhamos os pontos
                let pontos = corrida.dados_pontos;
                if (pontos && typeof pontos === 'string') {
                    try { pontos = JSON.parse(pontos); } catch { pontos = null; }
                }
                
                // Normaliza status de cada ponto nos dois formatos possíveis (webhook + sync)
                const normalizar = (p) => {
                    if (!p) return 'pendente';
                    if (p.status && ['chegou','coletado','finalizado','pendente'].includes(p.status)) return p.status;
                    const codigo = (p.codigo || '').toUpperCase();
                    if (codigo === 'CHE') return 'chegou';
                    if (codigo === 'COL') return 'coletado';
                    if (codigo === 'FIN') return 'finalizado';
                    return 'pendente';
                };
                
                const statusColeta = pontos && pontos[0] ? normalizar(pontos[0]) : 'pendente';
                const statusEntrega = pontos && pontos[1] ? normalizar(pontos[1]) : 'pendente';
                
                // Motoboy aceitou mas ainda não começou nada
                if (statusColeta === 'pendente' && statusEntrega === 'pendente') {
                    return { icone: '📦', texto: 'Aguardando coleta', cor: 'bg-amber-100 text-amber-700 border-amber-300' };
                }
                
                // Chegou na coleta mas ainda não coletou
                if (statusColeta === 'chegou' && statusEntrega === 'pendente') {
                    return { icone: '📍', texto: 'Motoboy chegou na coleta', cor: 'bg-blue-100 text-blue-700 border-blue-300' };
                }
                
                // Coletou (ou finalizou coleta) mas ainda não chegou na entrega
                if ((statusColeta === 'coletado' || statusColeta === 'finalizado') && statusEntrega === 'pendente') {
                    return { icone: '🏍️', texto: 'Motoboy a caminho da entrega', cor: 'bg-indigo-100 text-indigo-700 border-indigo-300' };
                }
                
                // Chegou no cliente
                if (statusEntrega === 'chegou') {
                    return { icone: '📍', texto: 'Motoboy no cliente', cor: 'bg-purple-100 text-purple-700 border-purple-300' };
                }
                
                // Entrega finalizada mas a corrida ainda não virou 'finalizado' (transição ou insucesso)
                if (statusEntrega === 'finalizado') {
                    return { icone: '✅', texto: 'Entrega finalizada', cor: 'bg-green-100 text-green-700 border-green-300' };
                }
                
                // Fallback defensivo
                return { icone: '🏍️', texto: 'Em andamento', cor: 'bg-blue-100 text-blue-700 border-blue-300' };
            };
            
            // Infere o sub-status atual a partir de dados_pontos (JSONB com eventos do webhook)
            // Usado para mostrar eventos intermediários no card da lista Ativas.
            // Lê dois formatos possíveis do JSONB:
            //   - Formato A (webhook): { status: 'chegou'|'coletado'|'finalizado', status_descricao, motivo_tipo }
            //   - Formato B (sync Tutts): { codigo: 'CHE'|'COL'|'FIN', statusPonto: { motivo, ocorrencia, ... } }
            const inferirSubStatus = (corrida) => {
                let pontos = corrida.dados_pontos;
                if (!pontos) return null;
                try {
                    if (typeof pontos === 'string') pontos = JSON.parse(pontos);
                } catch { return null; }
                if (!Array.isArray(pontos) || pontos.length === 0) return null;
                
                // Normaliza um ponto para { status, motivo } independente do formato
                const normalizar = (p) => {
                    if (!p) return null;
                    // Formato A (webhook)
                    if (p.status && ['chegou','coletado','finalizado','pendente'].includes(p.status)) {
                        return { status: p.status, motivo: p.motivo_tipo };
                    }
                    // Formato B (sync)
                    const codigo = (p.codigo || '').toUpperCase();
                    if (codigo === 'CHE') return { status: 'chegou', motivo: p.statusPonto?.ocorrencia };
                    if (codigo === 'COL') return { status: 'coletado', motivo: p.statusPonto?.ocorrencia };
                    if (codigo === 'FIN') return { status: 'finalizado', motivo: p.statusPonto?.ocorrencia || p.statusPonto?.motivo };
                    return { status: 'pendente' };
                };
                
                // Procura o último ponto com status não-pendente (mais recente)
                for (let i = pontos.length - 1; i >= 0; i--) {
                    const n = normalizar(pontos[i]);
                    if (!n || n.status === 'pendente') continue;
                    const isColeta = i === 0;
                    const tipo = isColeta ? 'coleta' : 'entrega';
                    
                    if (n.status === 'chegou') return { icone: '📍', texto: `Chegou na ${tipo}`, cor: 'bg-blue-50 text-blue-700 border-blue-200' };
                    if (n.status === 'coletado') return { icone: '📦', texto: 'Coletou, a caminho', cor: 'bg-indigo-50 text-indigo-700 border-indigo-200' };
                    if (n.status === 'finalizado') {
                        const motivo = (n.motivo || '').toLowerCase();
                        if (motivo && motivo !== 'sucesso' && motivo !== 'entregue') {
                            return { icone: '⚠️', texto: `Insucesso na ${tipo}`, cor: 'bg-orange-50 text-orange-700 border-orange-200' };
                        }
                        return { icone: '✅', texto: isColeta ? 'Coleta concluída' : 'Entregue', cor: 'bg-green-50 text-green-700 border-green-200' };
                    }
                }
                return null;
            };
            
            return (
                <div className="min-h-screen bg-gray-100">
                    <header className="bg-blue-900 text-white px-3 py-2 shadow-lg">
                        <div className="max-w-7xl mx-auto flex items-center justify-between">
                            <div className="flex items-center gap-2">
                                <span className="text-xl">🏍️</span>
                                <div>
                                    <h1 className="font-bold text-sm md:text-lg">Central Tutts</h1>
                                    <p className="text-xs text-blue-200 hidden md:block">{cliente.empresa || cliente.nome}</p>
                                </div>
                            </div>
                            <div className="flex items-center gap-2">
                                <button onClick={() => setMostrarHistorico(true)} className="text-xs bg-blue-800 hover:bg-blue-700 px-2 py-1 rounded">📋 Histórico</button>
                                <button onClick={onLogout} className="text-xs bg-red-600 hover:bg-red-700 px-2 py-1 rounded">Sair</button>
                            </div>
                        </div>
                    </header>
                    
                    {/* Abas */}
                    <div className="bg-white shadow border-b">
                        <div className="max-w-7xl mx-auto flex">
                            <button onClick={() => { setAbaAtiva('nova'); setCorridaSelecionada(null); }} className={`flex-1 md:flex-none px-4 py-3 text-sm font-medium border-b-2 ${abaAtiva === 'nova' ? 'text-blue-600 border-blue-600 bg-blue-50' : 'text-gray-500 border-transparent'}`}>📝 Nova</button>
                            <button onClick={() => { setAbaAtiva('acompanhar'); carregarCorridasAtivas(); }} className={`flex-1 md:flex-none px-4 py-3 text-sm font-medium border-b-2 flex items-center justify-center gap-2 ${abaAtiva === 'acompanhar' ? 'text-blue-600 border-blue-600 bg-blue-50' : 'text-gray-500 border-transparent'}`}>
                                🗺️ Ativas 
                                {corridasAtivas.length > 0 && <span className="bg-red-500 text-white text-xs px-1.5 py-0.5 rounded-full">{corridasAtivas.length}</span>}
                                {abaAtiva === 'acompanhar' && <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse" title="Atualizando em tempo real"></span>}
                            </button>
                            <button onClick={() => { setAbaAtiva('concluidas'); carregarConcluidas(); }} className={`flex-1 md:flex-none px-4 py-3 text-sm font-medium border-b-2 ${abaAtiva === 'concluidas' ? 'text-green-600 border-green-600 bg-green-50' : 'text-gray-500 border-transparent'}`}>✅ Concluídas</button>
                        </div>
                    </div>
                    
                    {/* ========== ABA NOVA SOLICITAÇÃO ========== */}
                    {abaAtiva === 'nova' && (
                        <>
                            <div className="md:hidden flex bg-white shadow">
                                <button onClick={() => setAbaMobile('form')} className={`flex-1 py-2 text-sm ${abaMobile === 'form' ? 'text-blue-600 border-b-2 border-blue-600' : 'text-gray-500'}`}>📝 Form</button>
                                <button onClick={() => setAbaMobile('mapa')} className={`flex-1 py-2 text-sm ${abaMobile === 'mapa' ? 'text-blue-600 border-b-2 border-blue-600' : 'text-gray-500'}`}>🗺️ Mapa</button>
                            </div>
                            <div className="max-w-7xl mx-auto p-2 md:p-4">
                                <div className="flex flex-col md:flex-row gap-4">
                                    <div className={`${abaMobile === 'form' ? 'block' : 'hidden'} md:block w-full md:w-96 space-y-3`}>
                                        {/* NOVO: Banner que pergunta se quer ajustar posição no mapa */}
                                        {promptAjuste.aberto && (
                                            <div className="bg-gradient-to-r from-blue-50 to-indigo-50 rounded-xl shadow border-2 border-blue-400 p-3 fade-in">
                                                <div className="flex items-start gap-2">
                                                    <span className="text-2xl">🎯</span>
                                                    <div className="flex-1">
                                                        <div className="text-sm font-bold text-blue-800">Deseja centralizar melhor o ponto?</div>
                                                        <div className="text-xs text-blue-600 mt-0.5">Use o mapa com satélite 3D para posicionar com precisão</div>
                                                        <div className="flex gap-2 mt-2">
                                                            <button onClick={aceitarAjusteMapa} className="flex-1 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs font-medium">✓ Sim, ajustar</button>
                                                            <button onClick={recusarAjusteMapa} className="flex-1 py-1.5 bg-gray-200 hover:bg-gray-300 text-gray-700 rounded-lg text-xs font-medium">Não, está OK</button>
                                                        </div>
                                                    </div>
                                                </div>
                                            </div>
                                        )}
                                        
                                        {/* PONTO DE COLETA */}
                                        <div className="bg-gradient-to-r from-amber-50 to-yellow-50 rounded-xl shadow border-2 border-amber-300 p-3">
                                            <div className="flex items-center justify-between mb-2">
                                                <span className="text-sm font-bold text-amber-800">📦 PONTO DE COLETA</span>
                                                {pontos.length > 0 && pontos[0] && <button onClick={salvarPartidaPadrao} className="text-xs text-amber-600 hover:text-amber-800 font-medium">⭐ Padrão</button>}
                                            </div>
                                            {pontos.length === 0 || !pontos[0] ? (
                                                <div>
                                                    <div className="flex gap-2">
                                                        <input type="text" value={termoBusca} onChange={(e) => setTermoBusca(e.target.value)} onKeyPress={(e) => e.key === 'Enter' && buscarEndereco()} className="flex-1 px-3 py-2 border border-amber-300 rounded-lg text-sm outline-none bg-white" placeholder="Digite apelido ou endereço..." />
                                                        <button onClick={buscarEndereco} disabled={buscando} className="px-3 py-2 bg-amber-500 text-white rounded-lg text-sm" title="Buscar no Google">{buscando ? '...' : '🔍'}</button>
                                                    </div>
                                                    {/* Endereços salvos */}
                                                    {mostrarSalvos && enderecosSalvos.length > 0 && (
                                                        <div className="mt-2 bg-amber-50 border border-amber-200 rounded-lg max-h-40 overflow-y-auto">
                                                            <div className="px-2 py-1 text-xs font-medium text-amber-700 border-b border-amber-200 bg-amber-100">💾 Endereços salvos</div>
                                                            {enderecosSalvos.map((e, i) => (
                                                                <div key={i} onClick={() => adicionarPontoSalvo(e)} className="p-2 hover:bg-amber-100 cursor-pointer text-xs border-b border-amber-100">
                                                                    <div className="font-medium text-amber-800">⭐ {e.apelido}</div>
                                                                    <div className="text-gray-600 truncate">{e.endereco_completo || `${e.rua}, ${e.numero} - ${e.bairro}, ${e.cidade}`}{e.complemento && ` (${e.complemento})`}</div>
                                                                </div>
                                                            ))}
                                                        </div>
                                                    )}
                                                    {/* Sugestões do Google */}
                                                    {/* Sugestões do Google OU prompt de número quando endereço não tem número */}
                                                    {aguardandoNumero.aberto ? (
                                                        <div className="mt-2 bg-amber-50 border-2 border-amber-400 rounded-lg p-3 fade-in">
                                                            <div className="flex items-start gap-2 mb-2">
                                                                <span className="text-lg">🔢</span>
                                                                <div className="flex-1">
                                                                    <div className="text-xs font-bold text-amber-800">Endereço sem número</div>
                                                                    <div className="text-xs text-amber-700 mt-0.5 truncate">📍 {aguardandoNumero.sugestao?.endereco}</div>
                                                                </div>
                                                            </div>
                                                            <div className="flex gap-2 mb-2">
                                                                <input
                                                                    type="text"
                                                                    autoFocus
                                                                    value={aguardandoNumero.numero}
                                                                    onChange={(e) => setAguardandoNumero(prev => ({ ...prev, numero: e.target.value }))}
                                                                    onKeyPress={(e) => { if (e.key === 'Enter') confirmarNumeroManual(); }}
                                                                    placeholder="Digite o número"
                                                                    className="flex-1 px-3 py-2 border border-amber-300 rounded-lg text-sm outline-none bg-white"
                                                                />
                                                                <button onClick={confirmarNumeroManual} className="px-3 py-2 bg-amber-600 hover:bg-amber-700 text-white rounded-lg text-sm font-medium">✓</button>
                                                            </div>
                                                            <div className="flex gap-2">
                                                                <button onClick={marcarSemNumero} className="flex-1 py-1.5 bg-white border border-amber-300 hover:bg-amber-100 text-amber-700 rounded-lg text-xs font-medium">🚫 S/N (sem número)</button>
                                                                <button onClick={cancelarPromptNumero} className="px-3 py-1.5 text-gray-500 hover:text-gray-700 text-xs">Cancelar</button>
                                                            </div>
                                                        </div>
                                                    ) : (
                                                        sugestoes.length > 0 && <div className="mt-2 bg-white border border-amber-200 rounded-lg max-h-48 overflow-y-auto">{sugestoes.map((s, i) => <div key={i} className="p-2 hover:bg-amber-50 border-b cursor-pointer" onClick={() => adicionarPonto(s)}><span className="text-xs">📍 {s.endereco}</span></div>)}</div>
                                                    )}
                                                </div>
                                            ) : (
                                                <div className="bg-white rounded-lg p-2 border border-amber-200">
                                                    <div className="flex items-center gap-2">
                                                        <span className="w-8 h-8 rounded-full bg-amber-500 flex items-center justify-center text-white text-sm font-bold">📦</span>
                                                        <div className="flex-1 min-w-0">
                                                            {pontos[0].apelido_salvo && <div className="text-xs text-amber-600 font-medium">⭐ {pontos[0].apelido_salvo}</div>}
                                                            <div className="text-xs font-medium truncate">{pontos[0].endereco_completo || `${pontos[0].rua}, ${pontos[0].numero}`}</div>
                                                            {pontos[0].complemento && <div className="text-xs text-amber-700">🏠 {pontos[0].complemento}</div>}
                                                            {pontos[0].bairro && <div className="text-xs text-gray-500">{pontos[0].bairro}, {pontos[0].cidade}</div>}
                                                            {pontos[0].numero_nota && <div className="text-xs text-amber-600">🏷️ {pontos[0].numero_nota}</div>}
                                                            {pontos[0].observacao && <div className="text-xs text-gray-500 truncate">📝 {pontos[0].observacao}</div>}
                                                            {pontos[0].ajustado_manualmente && <div className="text-xs text-green-600">🎯 Posição ajustada</div>}
                                                        </div>
                                                        <div className="flex gap-1">
                                                            {!pontos[0].endereco_salvo_id && (
                                                                <button onClick={() => { setModalSalvarEndereco({ aberto: true, ponto: pontos[0] }); setApelidoSalvar(''); setComplementoSalvar(pontos[0].complemento || ''); }} className="text-gray-400 hover:text-green-600 text-sm" title="Salvar endereço">💾</button>
                                                            )}
                                                            <button onClick={() => abrirEdicaoPonto(0)} className="text-gray-400 hover:text-amber-600 text-sm">✏️</button>
                                                            <button onClick={() => removerPonto(pontos[0].id)} className="text-gray-400 hover:text-red-600">✕</button>
                                                        </div>
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                        
                                        {/* PONTOS DE ENTREGA */}
                                        <div className="bg-white rounded-xl shadow p-3">
                                            <div className="flex items-center justify-between mb-2">
                                                <span className="text-sm font-bold text-blue-800">📍 PONTO DE ENTREGA {pontos.length > 1 ? '(1/1)' : '(0/1)'}</span>
                                                {pontos.length > 1 && <button onClick={() => setPontos(pontos.slice(0, 1))} className="text-xs text-red-500 hover:text-red-700">Limpar</button>}
                                            </div>
                                            {pontos.length > 0 && (
                                                <div className="mb-2">
                                                    <div className="flex gap-2">
                                                        <input type="text" value={termoBusca} onChange={(e) => setTermoBusca(e.target.value)} onKeyPress={(e) => e.key === 'Enter' && buscarEndereco()} className="flex-1 px-3 py-2 border rounded-lg text-sm outline-none" placeholder="Digite apelido ou endereço..." />
                                                        <button onClick={buscarEndereco} disabled={buscando} className="px-3 py-2 bg-blue-600 text-white rounded-lg text-sm" title="Buscar no Google">{buscando ? '...' : '🔍'}</button>
                                                    </div>
                                                    {/* Endereços salvos */}
                                                    {mostrarSalvos && enderecosSalvos.length > 0 && (
                                                        <div className="mt-2 bg-blue-50 border border-blue-200 rounded-lg max-h-40 overflow-y-auto">
                                                            <div className="px-2 py-1 text-xs font-medium text-blue-700 border-b border-blue-200 bg-blue-100">💾 Endereços salvos</div>
                                                            {enderecosSalvos.map((e, i) => (
                                                                <div key={i} onClick={() => adicionarPontoSalvo(e)} className="p-2 hover:bg-blue-100 cursor-pointer text-xs border-b border-blue-100">
                                                                    <div className="font-medium text-blue-800">⭐ {e.apelido}</div>
                                                                    <div className="text-gray-600 truncate">{e.endereco_completo || `${e.rua}, ${e.numero} - ${e.bairro}, ${e.cidade}`}{e.complemento && ` (${e.complemento})`}</div>
                                                                </div>
                                                            ))}
                                                        </div>
                                                    )}
                                                    {/* Sugestões do Google */}
                                                    {/* Sugestões do Google OU prompt de número quando endereço não tem número */}
                                                    {aguardandoNumero.aberto ? (
                                                        <div className="mt-2 bg-blue-50 border-2 border-blue-400 rounded-lg p-3 fade-in">
                                                            <div className="flex items-start gap-2 mb-2">
                                                                <span className="text-lg">🔢</span>
                                                                <div className="flex-1">
                                                                    <div className="text-xs font-bold text-blue-800">Endereço sem número</div>
                                                                    <div className="text-xs text-blue-700 mt-0.5 truncate">📍 {aguardandoNumero.sugestao?.endereco}</div>
                                                                </div>
                                                            </div>
                                                            <div className="flex gap-2 mb-2">
                                                                <input
                                                                    type="text"
                                                                    autoFocus
                                                                    value={aguardandoNumero.numero}
                                                                    onChange={(e) => setAguardandoNumero(prev => ({ ...prev, numero: e.target.value }))}
                                                                    onKeyPress={(e) => { if (e.key === 'Enter') confirmarNumeroManual(); }}
                                                                    placeholder="Digite o número"
                                                                    className="flex-1 px-3 py-2 border border-blue-300 rounded-lg text-sm outline-none bg-white"
                                                                />
                                                                <button onClick={confirmarNumeroManual} className="px-3 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium">✓</button>
                                                            </div>
                                                            <div className="flex gap-2">
                                                                <button onClick={marcarSemNumero} className="flex-1 py-1.5 bg-white border border-blue-300 hover:bg-blue-100 text-blue-700 rounded-lg text-xs font-medium">🚫 S/N (sem número)</button>
                                                                <button onClick={cancelarPromptNumero} className="px-3 py-1.5 text-gray-500 hover:text-gray-700 text-xs">Cancelar</button>
                                                            </div>
                                                        </div>
                                                    ) : (
                                                        sugestoes.length > 0 && <div className="mt-2 bg-white border rounded-lg max-h-48 overflow-y-auto">{sugestoes.map((s, i) => <div key={i} className="p-2 hover:bg-blue-50 border-b cursor-pointer" onClick={() => adicionarPonto(s)}><span className="text-xs">📍 {s.endereco}</span></div>)}</div>
                                                    )}
                                                </div>
                                            )}
                                            <div className="space-y-2 max-h-64 overflow-y-auto">
                                                {pontos.length <= 1 ? (
                                                    <div className="text-center py-4 text-gray-400 text-sm">{pontos.length === 0 ? 'Defina a coleta primeiro' : 'Adicione pontos de entrega'}</div>
                                                ) : pontos.slice(1).map((p, idx) => (
                                                    <div key={p.id}>
                                                        <div className={`p-2 rounded-lg border ${pontoRecemAdicionado === p.id ? 'bg-green-50 border-green-300' : 'bg-blue-50 border-blue-200'}`}>
                                                            <div className="flex items-center gap-2">
                                                                <span className="w-7 h-7 rounded-full bg-blue-600 flex items-center justify-center text-white text-xs font-bold">{idx + 1}</span>
                                                                <div className="flex-1 min-w-0">
                                                                    {p.apelido_salvo && <div className="text-xs text-blue-600 font-medium">⭐ {p.apelido_salvo}</div>}
                                                                    <div className="text-xs font-medium truncate">{p.endereco_completo || `${p.rua}, ${p.numero}`}</div>
                                                                    {p.complemento && <div className="text-xs text-blue-700">🏠 {p.complemento}</div>}
                                                                    {p.bairro && <div className="text-xs text-gray-500 truncate">{p.bairro}</div>}
                                                                    {p.numero_nota && <div className="text-xs text-green-600 font-medium">🏷️ Nota: {p.numero_nota}</div>}
                                                                    {p.observacao && <div className="text-xs text-blue-600 truncate">📝 {p.observacao}</div>}
                                                                    {p.ajustado_manualmente && <div className="text-xs text-green-600">🎯 Posição ajustada</div>}
                                                                </div>
                                                                <div className="flex gap-1">
                                                                    {!p.endereco_salvo_id && (
                                                                        <button onClick={(e) => { e.stopPropagation(); setModalSalvarEndereco({ aberto: true, ponto: p }); setApelidoSalvar(''); setComplementoSalvar(p.complemento || ''); }} className="text-gray-400 hover:text-green-600 text-sm" title="Salvar endereço">💾</button>
                                                                    )}
                                                                    <button onClick={() => abrirEdicaoPonto(idx + 1)} className="text-gray-400 hover:text-blue-600 text-sm">✏️</button>
                                                                    <button onClick={() => removerPonto(p.id)} className="text-gray-400 hover:text-red-600">✕</button>
                                                                </div>
                                                            </div>
                                                        </div>
                                                        
                                                        {/* Input de nota rápida - aparece logo após adicionar o ponto */}
                                                        {pontoRecemAdicionado === p.id && (
                                                            <div className="slide-down mt-2 p-2 bg-green-50 border border-green-200 rounded-lg">
                                                                <div className="flex items-center gap-2">
                                                                    <span className="text-xs text-green-700">🏷️</span>
                                                                    <input 
                                                                        ref={notaInputRef}
                                                                        type="text" 
                                                                        value={notaRapida} 
                                                                        onChange={(e) => setNotaRapida(e.target.value)}
                                                                        onKeyPress={(e) => { if (e.key === 'Enter') salvarNotaRapida(); }}
                                                                        className="flex-1 px-2 py-1 border border-green-300 rounded text-xs outline-none focus:ring-1 focus:ring-green-400" 
                                                                        placeholder="Nº Nota/Pedido (opcional)"
                                                                    />
                                                                    <button onClick={salvarNotaRapida} className="px-2 py-1 bg-green-600 text-white rounded text-xs hover:bg-green-700">✓</button>
                                                                    <button onClick={pularNotaRapida} className="px-2 py-1 text-gray-500 hover:text-gray-700 text-xs">Pular</button>
                                                                </div>
                                                            </div>
                                                        )}
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                        
                                        {/* Configurações */}
                                        <div className="bg-white rounded-xl shadow p-3">
                                            <div className="text-sm font-bold text-gray-700 mb-2">⚙️ Configurações</div>
                                            <div>
                                                <label className="text-xs text-gray-600">🏍️ Motoboy Específico</label>
                                                <select value={config.codigo_profissional} onChange={(e) => setConfig({...config, codigo_profissional: e.target.value})} className={`w-full px-2 py-1.5 border rounded text-sm ${config.codigo_profissional ? 'border-green-400 bg-green-50' : ''}`} disabled={carregandoProfissionais || profissionais.length === 0}>
                                                    <option value="">{carregandoProfissionais ? '⏳ Carregando...' : profissionais.length === 0 ? '❌ Nenhum disponível' : '🔄 Disparar para todos'}</option>
                                                    {profissionais.map(p => (<option key={p.codigo} value={p.codigo}>{p.nome}</option>))}
                                                </select>
                                                {config.codigo_profissional && <div className="text-xs text-green-600 mt-1">✅ Corrida para: {profissionais.find(p => p.codigo === config.codigo_profissional)?.nome}</div>}
                                            </div>
                                            <div className="flex flex-wrap gap-4 mt-3">
                                                <label className="flex items-center gap-2 text-sm cursor-pointer"><input type="checkbox" checked={config.retorno} onChange={(e) => setConfig({...config, retorno: e.target.checked})} className="w-4 h-4" />↩️ Retorno</label>
                                            </div>
                                        </div>
                                        
                                        {/* Botão Enviar */}
                                        <button onClick={enviarSolicitacao} disabled={loading || pontos.length < 2} className={`w-full py-3 text-white rounded-xl font-bold text-sm shadow-lg disabled:opacity-50 ${config.codigo_profissional ? 'bg-green-600 hover:bg-green-700' : 'bg-blue-600 hover:bg-blue-700'}`}>
                                            {loading ? '⏳ Enviando...' : `🚀 Solicitar Corrida (${pontos.length} pts)`}
                                        </button>
                                    </div>
                                    
                                    {/* Mapa */}
                                    <div className={`${abaMobile === 'mapa' ? 'block' : 'hidden'} md:block flex-1`}>
                                        <MapaLeaflet key={`nova-${mapaKey}`} id="mapa-nova" pontos={pontos} center={localizacaoUsuario ? [localizacaoUsuario.lat, localizacaoUsuario.lng] : undefined} zoom={localizacaoUsuario ? 14 : 12} height="calc(100vh - 200px)" tipo="nova" />
                                    </div>
                                </div>
                            </div>
                        </>
                    )}
                    
                    {/* ========== ABA ACOMPANHAR ========== */}
                    {abaAtiva === 'acompanhar' && (
                        <div className="max-w-7xl mx-auto p-2 md:p-4">
                            <div className="flex flex-col md:flex-row gap-4">
                                <div className="w-full md:w-80 space-y-3">
                                    <div className="bg-white rounded-xl shadow p-3">
                                        <div className="flex items-center justify-between mb-3">
                                            <div className="flex items-center gap-2">
                                                <span className="text-sm font-bold text-gray-700">🏍️ Corridas Ativas ({corridasAtivas.length})</span>
                                                <span className="flex items-center gap-1 text-xs text-green-600 bg-green-50 px-2 py-0.5 rounded-full">
                                                    <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></span>
                                                    Ao vivo
                                                </span>
                                            </div>
                                        </div>
                                        {corridasAtivas.length === 0 ? (
                                            <div className="text-center py-8 text-gray-400"><div className="text-4xl mb-2">📭</div><div className="text-sm">Nenhuma corrida ativa</div></div>
                                        ) : (
                                            <div className="space-y-2 max-h-[calc(100vh-280px)] overflow-y-auto">
                                                {corridasAtivas.map(c => {
                                                    const { coletas, entregas } = contarPontos(c);
                                                    // Buscar notas dos pontos (se disponível)
                                                    const notas = c.notas_pontos || [];
                                                    // Verificar se tem ponto de retorno
                                                    const temRetorno = c.pontos?.some(p => p.is_retorno || p.tipo_ponto === 'retorno') || 
                                                                       (c.dados_pontos && JSON.parse(typeof c.dados_pontos === 'string' ? c.dados_pontos : JSON.stringify(c.dados_pontos || []))?.some(p => p.is_retorno));
                                                    return (
                                                        <div key={c.id} onClick={() => selecionarCorrida(c.id)} className={`p-3 rounded-lg border-2 cursor-pointer transition-all ${temRetorno ? 'border-orange-400 bg-orange-50' : corridaSelecionada === c.id ? 'border-blue-500 bg-blue-50 shadow-md' : 'border-gray-200 hover:border-gray-300 hover:shadow'}`}>
                                                            <div className="flex items-center justify-between mb-2">
                                                                <div className="flex items-center gap-2 min-w-0 flex-1">
                                                                    {c.profissional_foto ? <img src={c.profissional_foto} className="w-8 h-8 rounded-full object-cover border-2 border-gray-200" /> : <div className="w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center text-sm">🏍️</div>}
                                                                    <span className="font-medium text-sm text-gray-800 truncate">{c.profissional_nome || 'Aguardando...'}</span>
                                                                </div>
                                                                <span className="text-xs font-bold text-gray-600 whitespace-nowrap">OS #{c.tutts_os_numero || c.id}</span>
                                                            </div>
                                                            {/* Status unificado: mensagem descritiva baseada no status + eventos do webhook */}
                                                            {(() => {
                                                                const estado = analisarEstadoCorrida(c);
                                                                return (
                                                                    <div className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium border ${estado.cor}`}>
                                                                        <span>{estado.icone}</span>
                                                                        <span>{estado.texto}</span>
                                                                    </div>
                                                                );
                                                            })()}
                                                            {/* Alerta de retorno */}
                                                            {temRetorno && (
                                                                <div className="mt-2 group relative">
                                                                    <div className="flex items-center gap-1 px-2 py-1 bg-orange-100 border border-orange-300 rounded text-xs text-orange-700 font-medium">
                                                                        <span>⚠️</span>
                                                                        <span>Atenção: Corrida com retorno</span>
                                                                    </div>
                                                                    <div className="absolute bottom-full left-0 mb-1 hidden group-hover:block z-50">
                                                                        <div className="bg-gray-900 text-white text-xs rounded py-2 px-3 whitespace-nowrap shadow-lg">
                                                                            Caso o retorno seja indevido, solicite o<br/>cancelamento ao suporte Tutts.
                                                                        </div>
                                                                        <div className="w-2 h-2 bg-gray-900 transform rotate-45 absolute left-4 -bottom-1"></div>
                                                                    </div>
                                                                </div>
                                                            )}
                                                            <div className="flex items-center justify-between mt-2 text-xs text-gray-500">
                                                                <span>📦 {coletas} → 📍 {entregas}</span>
                                                            </div>
                                                            {c.primeiro_numero_nota && <div className="mt-2 text-xs text-green-600 font-medium">🏷️ {c.primeiro_numero_nota}</div>}
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        )}
                                    </div>
                                </div>
                                
                                <div className="flex-1">
                                    {!corridaSelecionada ? (
                                        <div className="bg-white rounded-xl shadow p-8 text-center text-gray-400"><div className="text-6xl mb-4">👈</div><div>Selecione uma corrida para ver detalhes</div></div>
                                    ) : !detalheCorrida ? (
                                        <div className="bg-white rounded-xl shadow p-8 text-center"><div className="text-2xl animate-pulse">⏳</div><div className="text-gray-500 mt-2">Carregando...</div></div>
                                    ) : (
                                        <div className="space-y-3">
                                            {/* Card compacto: OS + Profissional + Telefone + Nota + Ações */}
                                            <div className={`p-3 rounded-xl border ${statusCores[detalheCorrida.status]}`}>
                                                <div className="flex items-center gap-3">
                                                    {/* Foto */}
                                                    {detalheCorrida.profissional_foto ? (
                                                        <img src={detalheCorrida.profissional_foto} className="w-12 h-12 rounded-full object-cover border-2 border-white shadow flex-shrink-0" />
                                                    ) : (
                                                        <div className="w-12 h-12 rounded-full bg-gray-200 flex items-center justify-center flex-shrink-0 text-lg">🏍️</div>
                                                    )}
                                                    
                                                    {/* Info */}
                                                    <div className="flex-1 min-w-0">
                                                        <div className="flex items-center gap-2 flex-wrap">
                                                            <span className="font-bold text-sm">OS #{detalheCorrida.tutts_os_numero || detalheCorrida.id}</span>
                                                            {(() => {
                                                                const estado = analisarEstadoCorrida(detalheCorrida);
                                                                return (
                                                                    <span className={`text-xs px-2 py-0.5 rounded-full border ${estado.cor}`}>{estado.icone} {estado.texto}</span>
                                                                );
                                                            })()}
                                                        </div>
                                                        <div className="text-sm font-medium text-gray-800 truncate">{detalheCorrida.profissional_nome || 'Aguardando profissional...'}</div>
                                                        <div className="flex items-center gap-3 text-xs text-gray-600 mt-1">
                                                            {detalheCorrida.profissional_telefone && (
                                                                <a href={`tel:${detalheCorrida.profissional_telefone}`} className="flex items-center gap-1 text-blue-600 hover:text-blue-800">
                                                                    📞 {detalheCorrida.profissional_telefone}
                                                                </a>
                                                            )}
                                                            {detalheCorrida.pontos?.[1]?.numero_nota && (
                                                                <span className="text-green-600">🏷️ {detalheCorrida.pontos[1].numero_nota}</span>
                                                            )}
                                                        </div>
                                                    </div>
                                                    
                                                    {/* Botões de ação no canto direito */}
                                                    <div className="flex flex-col gap-1 flex-shrink-0">
                                                        {detalheCorrida.tutts_url_rastreamento && (
                                                            <a href={detalheCorrida.tutts_url_rastreamento} target="_blank" className="px-2 py-1 bg-gray-700 text-white rounded text-xs hover:bg-gray-800 text-center">
                                                                🗺️ Rastrear
                                                            </a>
                                                        )}
                                                        {!['finalizado', 'cancelado'].includes(detalheCorrida.status) && (
                                                            <button onClick={() => cancelarCorrida(detalheCorrida.id)} className="px-2 py-1 bg-red-100 text-red-600 rounded text-xs hover:bg-red-200">
                                                                ✕ Cancelar
                                                            </button>
                                                        )}
                                                    </div>
                                                </div>
                                                {/* Alerta de retorno no detalhe */}
                                                {detalheCorrida.pontos?.some(p => p.is_retorno || p.tipo_ponto === 'retorno') && (
                                                    <div className="mt-2 group relative inline-block">
                                                        <div className="flex items-center gap-2 px-3 py-2 bg-orange-100 border border-orange-300 rounded-lg text-sm text-orange-700 font-medium cursor-help">
                                                            <span className="text-lg">⚠️</span>
                                                            <span>Atenção: Corrida com retorno</span>
                                                        </div>
                                                        <div className="absolute bottom-full left-0 mb-2 hidden group-hover:block z-50">
                                                            <div className="bg-gray-900 text-white text-xs rounded py-2 px-3 whitespace-nowrap shadow-lg">
                                                                Caso o retorno seja indevido, solicite o<br/>cancelamento ao suporte Tutts.
                                                            </div>
                                                            <div className="w-2 h-2 bg-gray-900 transform rotate-45 absolute left-4 -bottom-1"></div>
                                                        </div>
                                                    </div>
                                                )}
                                            </div>
                                            
                                            {/* Métricas compactas */}
                                            <div className="grid grid-cols-3 gap-2">
                                                <div className="bg-white p-2 rounded-lg shadow text-center">
                                                    <div className="text-sm font-bold text-blue-600">{detalheCorrida.tutts_distancia || '-'} km</div>
                                                    <div className="text-xs text-gray-400">Dist.</div>
                                                </div>
                                                <div className="bg-white p-2 rounded-lg shadow text-center">
                                                    <div className="text-sm font-bold text-blue-600">{detalheCorrida.tutts_duracao || '-'}</div>
                                                    <div className="text-xs text-gray-400">Tempo</div>
                                                </div>
                                                <div className="bg-white p-2 rounded-lg shadow text-center">
                                                    <div className="text-sm font-bold text-purple-600">{detalheCorrida.pontos?.length || 0}</div>
                                                    <div className="text-xs text-gray-400">Pontos</div>
                                                </div>
                                            </div>
                                            
                                            <div className="flex flex-col md:flex-row gap-4">
                                                <div className="w-full md:w-80 bg-white p-4 rounded-xl shadow">
                                                    <div className="text-sm font-bold text-gray-700 mb-3">📍 Pontos da Rota</div>
                                                    <div className="space-y-3 max-h-80 overflow-y-auto">
                                                        {detalheCorrida.pontos?.map((p, idx) => {
                                                            const isColeta = idx === 0;
                                                            const status = p.status || 'pendente';
                                                            // Montar endereço completo de forma inteligente
                                                            const partes = [p.rua, p.numero, p.bairro, p.cidade, p.uf].filter(x => x && x.trim());
                                                            const enderecoMontado = partes.length > 0 ? partes.join(', ') : null;
                                                            const enderecoFinal = p.endereco_completo || enderecoMontado || 'Endereço não informado';
                                                            
                                                            // Normalizar fotos para array
                                                            let fotosArray = [];
                                                            try {
                                                                if (typeof p.fotos === 'string' && p.fotos !== '' && p.fotos !== '[]') {
                                                                    fotosArray = JSON.parse(p.fotos);
                                                                } else if (Array.isArray(p.fotos)) {
                                                                    fotosArray = p.fotos;
                                                                }
                                                            } catch { fotosArray = []; }
                                                            
                                                            // Verificar se é ponto de retorno
                                                            const isRetorno = p.is_retorno || p.tipo_ponto === 'retorno';
                                                            
                                                            // Cores específicas para retorno
                                                            const corBorda = isRetorno ? 'border-orange-300 bg-orange-50' : statusPontoCores[status];
                                                            const corIcone = isRetorno ? 'bg-orange-500' : (status === 'finalizado' ? 'bg-green-500' : status === 'chegou' || status === 'coletado' ? 'bg-blue-500' : isColeta ? 'bg-amber-500' : 'bg-gray-400');
                                                            
                                                            return (
                                                                <div key={idx} className={`p-3 rounded-lg border-2 ${corBorda}`}>
                                                                    <div className="flex items-start gap-2">
                                                                        <div className={`w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-bold flex-shrink-0 ${corIcone}`}>
                                                                            {isRetorno ? '↩️' : (status === 'finalizado' ? '✓' : isColeta ? '📦' : idx)}
                                                                        </div>
                                                                        <div className="flex-1 min-w-0">
                                                                            <div className="flex items-center gap-2 mb-1 flex-wrap">
                                                                                <span className={`text-xs font-bold ${isRetorno ? 'text-orange-700' : isColeta ? 'text-amber-700' : 'text-blue-700'}`}>
                                                                                    {isRetorno ? '↩️ RETORNO' : isColeta ? '📦 COLETA' : `📍 ENTREGA ${idx}`}
                                                                                </span>
                                                                                <span className={`text-xs px-1.5 py-0.5 rounded ${isRetorno ? 'bg-orange-100 text-orange-700' : statusPontoCores[status]}`}>
                                                                                    {statusPontoIcons[status]} {statusPontoNomes[status]}
                                                                                </span>
                                                                                {isRetorno && p.ponto_retorno_de && (
                                                                                    <span className="text-xs text-orange-600">(do ponto {p.ponto_retorno_de})</span>
                                                                                )}
                                                                            </div>
                                                                            <div className="text-xs text-gray-700 leading-relaxed">{enderecoFinal}</div>
                                                                            
                                                                            {/* Número da nota - só para entregas (não retorno) */}
                                                                            {!isColeta && !isRetorno && p.numero_nota && <div className="text-xs text-green-600 mt-1 font-medium">🏷️ Nota: {p.numero_nota}</div>}
                                                                            
                                                                            {/* Timeline unificada de eventos do ponto (chegou → coletou → finalizou) */}
                                                                            {(p.data_chegada || p.data_coletado || p.data_finalizado) && (
                                                                                <div className="mt-2 pt-2 border-t border-gray-200">
                                                                                    <div className="text-xs font-medium text-gray-500 mb-1.5">⏱️ Linha do tempo</div>
                                                                                    <div className="space-y-1">
                                                                                        {p.data_chegada && (
                                                                                            <div className="flex items-center gap-2 text-xs">
                                                                                                <span className="w-5 text-center">📍</span>
                                                                                                <span className="text-blue-700 flex-1">Chegou no {isColeta ? 'ponto' : 'cliente'}</span>
                                                                                                <span className="font-mono text-gray-600 text-xs">{formatarHora(p.data_chegada)}</span>
                                                                                            </div>
                                                                                        )}
                                                                                        {isColeta && p.data_coletado && (
                                                                                            <div className="flex items-center gap-2 text-xs">
                                                                                                <span className="w-5 text-center">📦</span>
                                                                                                <span className="text-indigo-700 flex-1">Confirmou coleta</span>
                                                                                                <span className="font-mono text-gray-600 text-xs">{formatarHora(p.data_coletado)}</span>
                                                                                            </div>
                                                                                        )}
                                                                                        {p.data_finalizado && (() => {
                                                                                            const motivo = (p.motivo_finalizacao || '').toLowerCase();
                                                                                            const sucesso = !motivo || motivo === 'sucesso' || motivo === 'entregue';
                                                                                            const label = isColeta ? 'Finalizou coleta' : (sucesso ? 'Entrega concluída' : 'Finalizado (insucesso)');
                                                                                            const icone = sucesso ? '✅' : '⚠️';
                                                                                            const corTexto = sucesso ? 'text-green-700' : 'text-orange-700';
                                                                                            return (
                                                                                                <div className="flex items-center gap-2 text-xs">
                                                                                                    <span className="w-5 text-center">{icone}</span>
                                                                                                    <span className={`${corTexto} flex-1 font-medium`}>{label}</span>
                                                                                                    <span className="font-mono text-gray-600 text-xs">{formatarHora(p.data_finalizado)}</span>
                                                                                                </div>
                                                                                            );
                                                                                        })()}
                                                                                    </div>
                                                                                </div>
                                                                            )}
                                                                            
                                                                            {/* Motivo de finalização - para entregas e retornos */}
                                                                            {!isColeta && p.motivo_finalizacao && (
                                                                                <div className={`mt-2 text-xs px-2 py-1 rounded ${
                                                                                    p.motivo_finalizacao.toLowerCase() === 'sucesso' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
                                                                                }`}>
                                                                                    {p.motivo_finalizacao.toLowerCase() === 'sucesso' ? '✅' : '⚠️'} {p.motivo_descricao || p.motivo_finalizacao}
                                                                                </div>
                                                                            )}
                                                                            
                                                                            {/* Fotos de protocolo - para entregas e retornos */}
                                                                            {!isColeta && fotosArray.length > 0 && (
                                                                                <div className="mt-2 text-xs">
                                                                                    <span className="text-blue-600 font-medium">📸 {fotosArray.length} foto(s):</span>
                                                                                    <div className="flex flex-wrap gap-1 mt-1">
                                                                                        {fotosArray.map((foto, fotoIdx) => (
                                                                                            <button 
                                                                                                key={fotoIdx}
                                                                                                onClick={() => abrirFotoModal(fotosArray, fotoIdx)}
                                                                                                className="px-2 py-0.5 bg-blue-100 text-blue-700 rounded hover:bg-blue-200"
                                                                                            >
                                                                                                Ver {fotoIdx + 1}
                                                                                            </button>
                                                                                        ))}
                                                                                    </div>
                                                                                </div>
                                                                            )}
                                                                        </div>
                                                                    </div>
                                                                </div>
                                                            );
                                                        })}
                                                    </div>
                                                </div>
                                                <div className="flex-1"><MapaLeaflet key={`acompanhar-${mapaKey}-${corridaSelecionada}`} id={`mapa-acompanhar-${corridaSelecionada}`} pontos={detalheCorrida.pontos} height="350px" tipo="acompanhar" /></div>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>
                    )}
                    
                    {/* ========== ABA CONCLUÍDAS ========== */}
                    {abaAtiva === 'concluidas' && (
                        <div className="max-w-7xl mx-auto p-2 md:p-4">
                            <div className="bg-white rounded-xl shadow p-4">
                                <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
                                    <h2 className="text-lg font-bold text-gray-800">✅ Corridas Concluídas</h2>
                                    <div className="flex gap-2 flex-wrap">
                                        <button 
                                            onClick={sincronizarHistorico} 
                                            disabled={sincronizandoHistorico}
                                            className={`px-3 py-1.5 rounded-lg text-sm flex items-center gap-1 ${sincronizandoHistorico ? 'bg-gray-300 text-gray-500 cursor-not-allowed' : 'bg-purple-100 text-purple-700 hover:bg-purple-200'}`}
                                        >
                                            {sincronizandoHistorico ? (
                                                <><span className="animate-spin">⏳</span> Sincronizando...</>
                                            ) : (
                                                <>🔄 Recuperar Dados</>
                                            )}
                                        </button>
                                        <select value={filtroConcluidas} onChange={(e) => setFiltroConcluidas(e.target.value)} className="px-3 py-1.5 border rounded-lg text-sm">
                                            <option value="todas">Todas</option>
                                            <option value="finalizadas">✅ Finalizadas</option>
                                            <option value="canceladas">❌ Canceladas</option>
                                        </select>
                                        <button onClick={carregarConcluidas} className="px-3 py-1.5 bg-gray-100 hover:bg-gray-200 rounded-lg text-sm">🔄 Atualizar</button>
                                    </div>
                                </div>
                                {corridasConcluidas.filter(c => filtroConcluidas === 'todas' || (filtroConcluidas === 'finalizadas' && c.status === 'finalizado') || (filtroConcluidas === 'canceladas' && c.status === 'cancelado')).length === 0 ? (
                                    <div className="text-center py-12 text-gray-400"><div className="text-5xl mb-3">📭</div><div>Nenhuma corrida {filtroConcluidas !== 'todas' ? filtroConcluidas : 'concluída'}</div></div>
                                ) : (
                                    <div className="overflow-x-auto">
                                        <table className="w-full text-sm">
                                            <thead className="bg-gray-50"><tr><th className="px-2 py-2 text-center font-medium text-gray-600 w-10"></th><th className="px-2 py-2 text-center font-medium text-gray-600 w-12">Foto</th><th className="px-3 py-2 text-left font-medium text-gray-600">OS</th><th className="px-3 py-2 text-left font-medium text-gray-600">Nota</th><th className="px-3 py-2 text-left font-medium text-gray-600">Status</th><th className="px-3 py-2 text-left font-medium text-gray-600">Data</th><th className="px-3 py-2 text-left font-medium text-gray-600">Profissional</th><th className="px-3 py-2 text-center font-medium text-gray-600">Pontos</th><th className="px-3 py-2 text-left font-medium text-gray-600">Distância</th></tr></thead>
                                            <tbody className="divide-y">
                                                {corridasConcluidas.filter(c => filtroConcluidas === 'todas' || (filtroConcluidas === 'finalizadas' && c.status === 'finalizado') || (filtroConcluidas === 'canceladas' && c.status === 'cancelado')).map(c => {
                                                    // Verificar se tem retorno e extrair primeira nota
                                                    let temRetorno = false;
                                                    let primeiraNotaFiscal = null;
                                                    try {
                                                        const dadosPontos = c.dados_pontos ? (typeof c.dados_pontos === 'string' ? JSON.parse(c.dados_pontos) : c.dados_pontos) : [];
                                                        temRetorno = dadosPontos?.some(p => p.is_retorno || p.tipo_ponto === 'retorno');
                                                        // Pegar primeira nota fiscal (do primeiro ponto de entrega, índice 1+)
                                                        const pontosEntrega = dadosPontos?.slice(1) || [];
                                                        const pontoComNota = pontosEntrega.find(p => p.numero_nota && p.numero_nota.trim() !== '');
                                                        primeiraNotaFiscal = pontoComNota?.numero_nota || null;
                                                    } catch(e) {}
                                                    
                                                    return (
                                                        <React.Fragment key={c.id}>
                                                            <tr className={`hover:bg-gray-50 cursor-pointer ${temRetorno ? 'bg-orange-50 border-l-4 border-l-orange-400' : ''}`} onClick={() => toggleExpandirCorrida(c.id)}>
                                                                <td className="px-2 py-3 text-center">
                                                                    <div className={`w-7 h-7 rounded-lg flex items-center justify-center text-sm font-bold transition-all duration-200 ${corridaExpandida === c.id ? 'bg-blue-500 text-white shadow-md rotate-90' : 'bg-gradient-to-br from-gray-100 to-gray-200 text-gray-600 hover:from-blue-100 hover:to-blue-200 hover:text-blue-600 shadow'}`}>
                                                                        <span className={`transition-transform duration-200 ${corridaExpandida === c.id ? 'rotate-45' : ''}`}>+</span>
                                                                    </div>
                                                                </td>
                                                                <td className="px-2 py-3 text-center">
                                                                    {c.profissional_foto ? (
                                                                        <img src={c.profissional_foto} className="w-8 h-8 rounded-full object-cover border border-gray-200 mx-auto" alt="" />
                                                                    ) : (
                                                                        <div className="w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center mx-auto text-sm">🏍️</div>
                                                                    )}
                                                                </td>
                                                                <td className="px-3 py-3 font-medium">
                                                                    #{c.tutts_os_numero || c.id}
                                                                    {temRetorno && <span className="ml-2 text-orange-500" title="Corrida com retorno">⚠️</span>}
                                                                </td>
                                                                <td className="px-3 py-3">
                                                                    {primeiraNotaFiscal ? (
                                                                        <span className="text-green-600 font-medium">🏷️ {primeiraNotaFiscal}</span>
                                                                    ) : (
                                                                        <span className="text-gray-400">-</span>
                                                                    )}
                                                                </td>
                                                                <td className="px-3 py-3"><span className={`px-2 py-1 rounded-full text-xs font-medium ${c.status === 'finalizado' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>{c.status === 'finalizado' ? '✅ Finalizada' : '❌ Cancelada'}</span></td>
                                                                <td className="px-3 py-3 text-gray-600">{new Date(c.criado_em).toLocaleDateString('pt-BR')} {new Date(c.criado_em).toLocaleTimeString('pt-BR', {hour: '2-digit', minute: '2-digit'})}</td>
                                                                <td className="px-3 py-3">{c.profissional_nome || <span className="text-gray-400">-</span>}</td>
                                                                <td className="px-3 py-3 text-center">{c.total_pontos || '-'}</td>
                                                                <td className="px-3 py-3">{c.tutts_distancia ? `${c.tutts_distancia} km` : '-'}</td>
                                                            </tr>
                                                            {/* Linha expandida com detalhes */}
                                                            {corridaExpandida === c.id && (
                                                                <tr>
                                                                    <td colSpan="9" className="px-4 py-4 bg-gray-50">
                                                                        {!detalhesCorridaExpandida ? (
                                                                            <div className="text-center py-4"><span className="animate-pulse">⏳ Carregando detalhes...</span></div>
                                                                        ) : (
                                                                            <div className="space-y-4">
                                                                                {/* Cabeçalho com foto do profissional e info */}
                                                                                <div className="flex items-start gap-4 p-3 bg-white rounded-lg border">
                                                                                    {detalhesCorridaExpandida.profissional_foto ? (
                                                                                        <img src={detalhesCorridaExpandida.profissional_foto} className="w-16 h-16 rounded-full object-cover border-2 border-gray-200" />
                                                                                    ) : (
                                                                                        <div className="w-16 h-16 rounded-full bg-gray-200 flex items-center justify-center text-2xl">🏍️</div>
                                                                                    )}
                                                                                    <div className="flex-1">
                                                                                        <div className="font-bold text-gray-800">{detalhesCorridaExpandida.profissional_nome || 'Sem profissional'}</div>
                                                                                        {detalhesCorridaExpandida.profissional_telefone && <div className="text-sm text-gray-600">📞 {detalhesCorridaExpandida.profissional_telefone}</div>}
                                                                                        <div className="flex gap-4 mt-2 text-xs text-gray-500">
                                                                                            <span>📏 {detalhesCorridaExpandida.tutts_distancia || '-'} km</span>
                                                                                            <span>📍 {detalhesCorridaExpandida.pontos?.length || 0} pontos</span>
                                                                                        </div>
                                                                                    </div>
                                                                                </div>
                                                                                
                                                                                {/* Alerta de retorno */}
                                                                                {detalhesCorridaExpandida.pontos?.some(p => p.is_retorno || p.tipo_ponto === 'retorno') && (
                                                                                    <div className="flex items-center gap-2 px-4 py-3 bg-orange-100 border border-orange-300 rounded-lg text-orange-700">
                                                                                        <span className="text-xl">⚠️</span>
                                                                                        <div>
                                                                                            <div className="font-bold">Atenção: Corrida com retorno</div>
                                                                                            <div className="text-sm">Caso o retorno seja indevido, solicite o cancelamento ao suporte Tutts.</div>
                                                                                        </div>
                                                                                    </div>
                                                                                )}
                                                                                
                                                                                {/* Lista de pontos */}
                                                                                <div className="space-y-2">
                                                                                    <div className="font-medium text-gray-700">📍 Pontos da corrida:</div>
                                                                                    {detalhesCorridaExpandida.pontos?.map((p, idx) => {
                                                                                        const isColeta = idx === 0;
                                                                                        const isRetorno = p.is_retorno || p.tipo_ponto === 'retorno';
                                                                                        
                                                                                        // Normalizar fotos
                                                                                        let fotosArray = [];
                                                                                        try {
                                                                                            if (typeof p.fotos === 'string' && p.fotos !== '' && p.fotos !== '[]') {
                                                                                                fotosArray = JSON.parse(p.fotos);
                                                                                            } else if (Array.isArray(p.fotos)) {
                                                                                                fotosArray = p.fotos;
                                                                                            }
                                                                                        } catch { fotosArray = []; }
                                                                                        
                                                                                        const endereco = p.endereco_completo || [p.rua, p.numero, p.bairro, p.cidade].filter(Boolean).join(', ') || 'Endereço não informado';
                                                                                        
                                                                                        return (
                                                                                            <div key={idx} className={`p-3 rounded-lg border-2 ${isRetorno ? 'border-orange-300 bg-orange-50' : isColeta ? 'border-amber-200 bg-amber-50' : 'border-gray-200 bg-white'}`}>
                                                                                                <div className="flex items-start gap-3">
                                                                                                    <div className={`w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-bold flex-shrink-0 ${isRetorno ? 'bg-orange-500' : isColeta ? 'bg-amber-500' : 'bg-blue-500'}`}>
                                                                                                        {isRetorno ? '↩️' : isColeta ? '📦' : idx}
                                                                                                    </div>
                                                                                                    <div className="flex-1">
                                                                                                        <div className="flex items-center gap-2 flex-wrap">
                                                                                                            <span className={`text-xs font-bold ${isRetorno ? 'text-orange-700' : isColeta ? 'text-amber-700' : 'text-blue-700'}`}>
                                                                                                                {isRetorno ? '↩️ RETORNO' : isColeta ? '📦 COLETA' : `📍 ENTREGA ${idx}`}
                                                                                                            </span>
                                                                                                            {isRetorno && p.ponto_retorno_de && (
                                                                                                                <span className="text-xs text-orange-600">(do ponto {p.ponto_retorno_de})</span>
                                                                                                            )}
                                                                                                            {p.numero_nota && <span className="text-xs text-green-600">🏷️ {p.numero_nota}</span>}
                                                                                                        </div>
                                                                                                        <div className="text-sm text-gray-700 mt-1">{endereco}</div>
                                                                                                        
                                                                                                        {/* Observação */}
                                                                                                        {p.observacao && (
                                                                                                            <div className="mt-2 text-xs text-gray-600 bg-gray-100 px-2 py-1 rounded">
                                                                                                                💬 {p.observacao}
                                                                                                            </div>
                                                                                                        )}
                                                                                                        
                                                                                                        {/* Motivo de finalização */}
                                                                                                        {p.motivo_finalizacao && (
                                                                                                            <div className={`mt-2 text-xs px-2 py-1 rounded ${p.motivo_finalizacao.toLowerCase() === 'sucesso' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                                                                                                                {p.motivo_finalizacao.toLowerCase() === 'sucesso' ? '✅' : '⚠️'} {p.motivo_descricao || p.motivo_finalizacao}
                                                                                                            </div>
                                                                                                        )}
                                                                                                        
                                                                                                        {/* Fotos de protocolo */}
                                                                                                        {fotosArray.length > 0 && (
                                                                                                            <div className="mt-2">
                                                                                                                <div className="text-xs text-gray-500 mb-1">📸 Fotos de protocolo:</div>
                                                                                                                <div className="flex gap-2 flex-wrap">
                                                                                                                    {fotosArray.map((foto, fIdx) => (
                                                                                                                        <img 
                                                                                                                            key={fIdx} 
                                                                                                                            src={foto} 
                                                                                                                            className="w-16 h-16 object-cover rounded cursor-pointer hover:opacity-80 border"
                                                                                                                            onClick={(e) => { e.stopPropagation(); abrirFotoModal(fotosArray, fIdx); }}
                                                                                                                        />
                                                                                                                    ))}
                                                                                                                </div>
                                                                                                            </div>
                                                                                                        )}
                                                                                                        
                                                                                                        {/* Horários */}
                                                                                                        {(p.data_chegada || p.data_coletado || p.data_finalizado) && (
                                                                                                            <div className="mt-2 pt-2 border-t border-gray-200">
                                                                                                                <div className="text-xs text-gray-500 mb-1">⏱️ Horários:</div>
                                                                                                                <div className="flex flex-wrap gap-3 text-xs">
                                                                                                                    {p.data_chegada && <span className="text-blue-600">🔵 Chegou: {new Date(p.data_chegada).toLocaleTimeString('pt-BR', {hour: '2-digit', minute: '2-digit'})}</span>}
                                                                                                                    {p.data_coletado && <span className="text-yellow-600">🟡 Coletou: {new Date(p.data_coletado).toLocaleTimeString('pt-BR', {hour: '2-digit', minute: '2-digit'})}</span>}
                                                                                                                    {p.data_finalizado && <span className="text-green-600">✅ Finalizado: {new Date(p.data_finalizado).toLocaleTimeString('pt-BR', {hour: '2-digit', minute: '2-digit'})}</span>}
                                                                                                                </div>
                                                                                                            </div>
                                                                                                        )}
                                                                                                    </div>
                                                                                                </div>
                                                                                            </div>
                                                                                        );
                                                                                    })}
                                                                                </div>
                                                                            </div>
                                                                        )}
                                                                    </td>
                                                                </tr>
                                                            )}
                                                        </React.Fragment>
                                                    );
                                                })}
                                            </tbody>
                                        </table>
                                    </div>
                                )}
                                {corridasConcluidas.length > 0 && (
                                    <div className="mt-4 pt-4 border-t grid grid-cols-3 gap-4">
                                        <div className="bg-green-50 p-3 rounded-lg text-center"><div className="text-2xl font-bold text-green-600">{corridasConcluidas.filter(c => c.status === 'finalizado').length}</div><div className="text-xs text-gray-600">Finalizadas</div></div>
                                        <div className="bg-red-50 p-3 rounded-lg text-center"><div className="text-2xl font-bold text-red-600">{corridasConcluidas.filter(c => c.status === 'cancelado').length}</div><div className="text-xs text-gray-600">Canceladas</div></div>
                                        <div className="bg-blue-50 p-3 rounded-lg text-center"><div className="text-2xl font-bold text-blue-600">{corridasConcluidas.filter(c => c.status === 'finalizado').reduce((acc, c) => acc + parseFloat(c.tutts_distancia || 0), 0).toFixed(1)} km</div><div className="text-xs text-gray-600">Total Distância</div></div>
                                    </div>
                                )}
                            </div>
                        </div>
                    )}
                    
                    {/* Modal salvar endereço */}
                    {modalSalvarEndereco.aberto && (
                        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => { setModalSalvarEndereco({ aberto: false, ponto: null }); setComplementoSalvar(''); }}>
                            <div className="bg-white rounded-xl shadow-2xl w-full max-w-sm p-4" onClick={e => e.stopPropagation()}>
                                <div className="flex items-center justify-between mb-4">
                                    <span className="font-bold text-green-700">💾 Salvar Endereço</span>
                                    <button onClick={() => { setModalSalvarEndereco({ aberto: false, ponto: null }); setComplementoSalvar(''); }} className="text-gray-400 hover:text-gray-600">✕</button>
                                </div>
                                
                                {/* Preview do endereço */}
                                <div className="bg-gray-50 p-3 rounded-lg mb-4 text-sm">
                                    <div className="font-medium text-gray-700">{modalSalvarEndereco.ponto?.endereco_completo || `${modalSalvarEndereco.ponto?.rua}, ${modalSalvarEndereco.ponto?.numero}`}</div>
                                    {modalSalvarEndereco.ponto?.bairro && <div className="text-xs text-gray-500">{modalSalvarEndereco.ponto?.bairro}, {modalSalvarEndereco.ponto?.cidade}</div>}
                                </div>
                                
                                {/* Input do complemento */}
                                <div className="mb-3">
                                    <label className="text-xs text-gray-600 font-medium">🏠 Complemento (opcional)</label>
                                    <input 
                                        type="text" 
                                        value={complementoSalvar} 
                                        onChange={(e) => setComplementoSalvar(e.target.value)}
                                        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm mt-1 focus:ring-2 focus:ring-green-400 outline-none" 
                                        placeholder="Quadra, Lote, Apto, Bloco..."
                                    />
                                </div>
                                
                                {/* Input do apelido */}
                                <div className="mb-4">
                                    <label className="text-xs text-gray-600 font-medium">⭐ Apelido (para buscar depois)</label>
                                    <input 
                                        type="text" 
                                        value={apelidoSalvar} 
                                        onChange={(e) => setApelidoSalvar(e.target.value)}
                                        onKeyPress={(e) => { if (e.key === 'Enter') salvarEndereco(); }}
                                        className="w-full px-3 py-2 border border-green-300 rounded-lg text-sm mt-1 focus:ring-2 focus:ring-green-400 outline-none" 
                                        placeholder="Ex: Loja Centro, CD Principal, Cliente X..."
                                        autoFocus
                                    />
                                    <div className="text-xs text-gray-400 mt-1">💡 Use um nome fácil de lembrar</div>
                                </div>
                                
                                <div className="flex gap-2">
                                    <button onClick={() => { setModalSalvarEndereco({ aberto: false, ponto: null }); setComplementoSalvar(''); }} className="flex-1 py-2 border rounded-lg text-sm hover:bg-gray-50">Cancelar</button>
                                    <button onClick={salvarEndereco} disabled={salvandoEndereco || !apelidoSalvar.trim()} className="flex-1 py-2 bg-green-600 text-white rounded-lg text-sm hover:bg-green-700 disabled:opacity-50">
                                        {salvandoEndereco ? '...' : '💾 Salvar'}
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}
                    
                    {/* Modal edição de ponto */}
                    {pontoEditando !== null && (
                        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => setPontoEditando(null)}>
                            <div className="bg-white rounded-xl shadow-2xl w-full max-w-md p-4" onClick={e => e.stopPropagation()}>
                                <div className="flex items-center justify-between mb-4">
                                    <span className="font-bold">✏️ Editar Ponto {pontoEditando + 1}</span>
                                    <button onClick={() => setPontoEditando(null)} className="text-gray-400 hover:text-gray-600">✕</button>
                                </div>
                                <div className="space-y-3">
                                    {/* Campo Número Nota - Destaque */}
                                    <div className="bg-green-50 p-3 rounded-lg border border-green-200">
                                        <label className="text-xs text-green-700 font-medium">🏷️ Número da Nota/Pedido</label>
                                        <input 
                                            type="text" 
                                            value={dadosPonto.numero_nota} 
                                            onChange={(e) => setDadosPonto({...dadosPonto, numero_nota: e.target.value})} 
                                            className="w-full px-3 py-2 border border-green-300 rounded text-sm mt-1 focus:ring-2 focus:ring-green-400 outline-none" 
                                            placeholder="Ex: NF-12345, PED-0001..."
                                        />
                                    </div>
                                    
                                    <div>
                                        <label className="text-xs text-gray-600">📝 Observação</label>
                                        <textarea value={dadosPonto.observacao} onChange={(e) => setDadosPonto({...dadosPonto, observacao: e.target.value})} className="w-full px-3 py-2 border rounded text-sm" rows="2" placeholder="Instruções para o motoboy..." />
                                    </div>
                                    <div>
                                        <label className="text-xs text-gray-600">🏠 Complemento</label>
                                        <input type="text" value={dadosPonto.complemento} onChange={(e) => setDadosPonto({...dadosPonto, complemento: e.target.value})} className="w-full px-3 py-2 border rounded text-sm" placeholder="Quadra, Lote, Apto, Bloco..." />
                                    </div>
                                    <div className="grid grid-cols-2 gap-3">
                                        <div>
                                            <label className="text-xs text-gray-600">📞 Telefone</label>
                                            <input type="text" value={dadosPonto.telefone} onChange={(e) => setDadosPonto({...dadosPonto, telefone: e.target.value})} className="w-full px-3 py-2 border rounded text-sm" placeholder="(62) 99999-9999" />
                                        </div>
                                        <div>
                                            <label className="text-xs text-gray-600">👤 Procurar por</label>
                                            <input type="text" value={dadosPonto.procurar_por} onChange={(e) => setDadosPonto({...dadosPonto, procurar_por: e.target.value})} className="w-full px-3 py-2 border rounded text-sm" placeholder="Nome do responsável" />
                                        </div>
                                    </div>
                                </div>
                                <div className="flex gap-2 mt-4">
                                    <button onClick={() => setPontoEditando(null)} className="flex-1 py-2 border rounded-lg text-sm hover:bg-gray-50">Cancelar</button>
                                    <button onClick={salvarEdicaoPonto} className="flex-1 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700">💾 Salvar</button>
                                </div>
                            </div>
                        </div>
                    )}
                    
                    {/* ============ Modal de Ajuste de Mapa (Google Maps com satélite 3D) ============ */}
                    {modalAjusteMapa.aberto && (
                        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-2 md:p-4">
                            <div className="bg-white rounded-xl shadow-2xl w-full max-w-5xl h-[92vh] overflow-hidden flex flex-col">
                                <div className="bg-blue-900 text-white px-4 py-3 flex items-center justify-between flex-shrink-0">
                                    <div className="flex items-center gap-2">
                                        <span className="text-xl">🎯</span>
                                        <div>
                                            <span className="font-bold">Ajustar Posição no Mapa</span>
                                            <div className="text-xs text-blue-200">{modalAjusteMapa.etapa === 'ajustar' ? 'Arraste o pino ou clique no mapa' : 'Confirme o endereço'}</div>
                                        </div>
                                    </div>
                                    <button onClick={fecharModalAjusteMapa} className="text-white/70 hover:text-white text-xl">✕</button>
                                </div>
                                
                                <div className="flex-1 overflow-hidden flex flex-col">
                                    {modalAjusteMapa.etapa === 'ajustar' ? (
                                        <>
                                            <div className="px-4 py-2 bg-gray-50 border-b flex-shrink-0">
                                                <div className="text-xs text-gray-500">Endereço buscado:</div>
                                                <div className="text-sm font-medium text-gray-700 truncate">📍 {modalAjusteMapa.sugestaoOriginal?.endereco}</div>
                                            </div>
                                            
                                            <div className="px-4 py-2 bg-blue-50 border-b flex-shrink-0">
                                                <div className="flex items-center gap-2 text-sm text-blue-700">
                                                    <span className="text-lg">👆</span>
                                                    <div><strong>Arraste o pino vermelho</strong> para a posição exata ou <strong>clique no mapa</strong></div>
                                                </div>
                                            </div>
                                            
                                            <div className="flex-1 min-h-[400px]">
                                                <MapaAjustavelGoogle 
                                                    latitude={posicaoAjustada.lat || modalAjusteMapa.latitude}
                                                    longitude={posicaoAjustada.lng || modalAjusteMapa.longitude}
                                                    onPosicaoMudou={onPosicaoMudou}
                                                    zoom={18}
                                                />
                                            </div>
                                            
                                            <div className="px-4 py-2 bg-gray-50 border-t flex-shrink-0">
                                                <div className="flex items-center justify-between text-xs text-gray-500">
                                                    <span>Coordenadas:</span>
                                                    <span className="font-mono">{posicaoAjustada.lat?.toFixed(6)}, {posicaoAjustada.lng?.toFixed(6)}</span>
                                                </div>
                                            </div>
                                            
                                            <div className="p-4 border-t flex gap-2 flex-shrink-0">
                                                <button onClick={fecharModalAjusteMapa} className="flex-1 py-2.5 bg-gray-200 hover:bg-gray-300 rounded-lg font-medium text-sm">Cancelar</button>
                                                <button onClick={confirmarPosicaoMapa} disabled={buscandoEnderecoReverso} className="flex-1 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium text-sm disabled:opacity-50">{buscandoEnderecoReverso ? '⏳ Buscando...' : '✓ Confirmar Posição'}</button>
                                            </div>
                                        </>
                                    ) : (
                                        <>
                                            <div className="p-4 space-y-4 overflow-y-auto">
                                                <div className="bg-gray-50 rounded-lg p-3">
                                                    <div className="text-xs text-gray-500 mb-1">Endereço original buscado:</div>
                                                    <div className="text-sm text-gray-600">📍 {modalAjusteMapa.sugestaoOriginal?.endereco}</div>
                                                </div>
                                                
                                                <div className="flex justify-center"><div className="w-10 h-10 rounded-full bg-green-100 flex items-center justify-center text-green-600 text-xl">↓</div></div>
                                                
                                                <div className="bg-green-50 rounded-lg p-3 border-2 border-green-200">
                                                    <div className="text-xs text-green-600 mb-1 font-medium">✅ Novo endereço (posição ajustada):</div>
                                                    <div className="text-sm font-medium text-gray-800">🎯 {enderecoAjustado?.endereco}</div>
                                                    <div className="mt-2 text-xs text-gray-500 font-mono">Coordenadas: {posicaoAjustada.lat?.toFixed(6)}, {posicaoAjustada.lng?.toFixed(6)}</div>
                                                </div>
                                                
                                                {enderecoAjustado && (
                                                    <div className="bg-blue-50 rounded-lg p-3">
                                                        <div className="text-xs text-blue-600 mb-2 font-medium">📋 Detalhes:</div>
                                                        <div className="grid grid-cols-2 gap-2 text-xs">
                                                            {enderecoAjustado.componentes?.find(c => c.types?.includes('route')) && <div><span className="text-gray-500">Rua:</span> <span className="font-medium">{enderecoAjustado.componentes.find(c => c.types?.includes('route'))?.long_name}</span></div>}
                                                            {enderecoAjustado.componentes?.find(c => c.types?.includes('street_number')) && <div><span className="text-gray-500">Nº:</span> <span className="font-medium">{enderecoAjustado.componentes.find(c => c.types?.includes('street_number'))?.long_name}</span></div>}
                                                            {enderecoAjustado.componentes?.find(c => c.types?.includes('sublocality_level_1') || c.types?.includes('sublocality')) && <div><span className="text-gray-500">Bairro:</span> <span className="font-medium">{enderecoAjustado.componentes.find(c => c.types?.includes('sublocality_level_1') || c.types?.includes('sublocality'))?.long_name}</span></div>}
                                                            {enderecoAjustado.componentes?.find(c => c.types?.includes('administrative_area_level_2') || c.types?.includes('locality')) && <div><span className="text-gray-500">Cidade:</span> <span className="font-medium">{enderecoAjustado.componentes.find(c => c.types?.includes('administrative_area_level_2') || c.types?.includes('locality'))?.long_name}</span></div>}
                                                        </div>
                                                    </div>
                                                )}
                                            </div>
                                            
                                            <div className="p-4 border-t flex gap-2 flex-shrink-0">
                                                <button onClick={voltarParaAjustar} className="flex-1 py-2.5 bg-gray-200 hover:bg-gray-300 rounded-lg font-medium text-sm">↩️ Ajustar</button>
                                                <button onClick={usarEnderecoAjustado} className="flex-1 py-2.5 bg-green-600 hover:bg-green-700 text-white rounded-lg font-medium text-sm">✓ Usar</button>
                                            </div>
                                        </>
                                    )}
                                </div>
                            </div>
                        </div>
                    )}
                    
                    {/* Modal histórico */}
                    {mostrarHistorico && (
                        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => setMostrarHistorico(false)}>
                            <div className="bg-white rounded-xl shadow-2xl w-full max-w-3xl max-h-[80vh] overflow-hidden" onClick={e => e.stopPropagation()}>
                                <div className="bg-blue-900 text-white px-4 py-3 flex items-center justify-between"><span className="font-bold">📋 Histórico</span><button onClick={() => setMostrarHistorico(false)} className="text-white/70 hover:text-white">✕</button></div>
                                <div className="p-4 overflow-y-auto max-h-[65vh]">
                                    {historico.length === 0 ? <p className="text-center text-gray-500 py-8">Nenhuma solicitação</p> : (
                                        <div className="space-y-2">
                                            {historico.map(h => (
                                                <div key={h.id} className="p-3 border rounded-lg hover:bg-gray-50">
                                                    <div className="flex items-center justify-between">
                                                        <div>
                                                            <div className="flex items-center gap-2">
                                                                <span className={`px-2 py-0.5 rounded text-xs font-medium ${statusCores[h.status]}`}>{statusIcons[h.status]} {statusNomes[h.status]}</span>
                                                                {h.tutts_os_numero && <span className="text-sm font-medium">OS #{h.tutts_os_numero}</span>}
                                                            </div>
                                                            <div className="text-xs text-gray-500 mt-1">{formatarData(h.criado_em)} • {h.total_pontos} pts{h.profissional_nome && ` • 🏍️ ${h.profissional_nome}`}</div>
                                                        </div>
                                                        <div className="flex items-center gap-2">
                                                            {h.tutts_valor && <div className="text-sm font-bold text-green-600">R$ {parseFloat(h.tutts_valor).toFixed(2)}</div>}
                                                            {h.tutts_os_numero && <button onClick={() => copiarLinkRastreio(h.tutts_os_numero)} className="text-xs text-blue-600 hover:text-blue-800">📋</button>}
                                                        </div>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>
                    )}
                    
                    {/* Modal de fotos com zoom */}
                    {fotoModal.aberto && (
                        <div className="fixed inset-0 bg-black/90 flex items-center justify-center foto-modal" onClick={fecharFotoModal}>
                            <div className="relative w-full h-full flex items-center justify-center p-4" onClick={e => e.stopPropagation()}>
                                {/* Botão fechar */}
                                <button onClick={fecharFotoModal} className="absolute top-4 right-4 text-white text-3xl hover:text-gray-300 z-10">✕</button>
                                
                                {/* Contador */}
                                <div className="absolute top-4 left-4 text-white text-sm bg-black/50 px-3 py-1 rounded-full">
                                    {fotoModal.indice + 1} / {fotoModal.fotos.length}
                                </div>
                                
                                {/* Botão anterior */}
                                {fotoModal.indice > 0 && (
                                    <button onClick={() => navegarFoto(-1)} className="absolute left-4 text-white text-5xl hover:text-gray-300">‹</button>
                                )}
                                
                                {/* Imagem */}
                                <img 
                                    src={typeof fotoModal.fotos[fotoModal.indice] === 'string' ? fotoModal.fotos[fotoModal.indice] : fotoModal.fotos[fotoModal.indice]?.url || fotoModal.fotos[fotoModal.indice]?.link}
                                    className="max-w-full max-h-full object-contain rounded-lg shadow-2xl"
                                    alt={`Foto ${fotoModal.indice + 1}`}
                                    onClick={e => e.stopPropagation()}
                                />
                                
                                {/* Botão próximo */}
                                {fotoModal.indice < fotoModal.fotos.length - 1 && (
                                    <button onClick={() => navegarFoto(1)} className="absolute right-4 text-white text-5xl hover:text-gray-300">›</button>
                                )}
                                
                                {/* Thumbnails */}
                                {fotoModal.fotos.length > 1 && (
                                    <div className="absolute bottom-4 left-1/2 transform -translate-x-1/2 flex gap-2">
                                        {fotoModal.fotos.map((foto, idx) => (
                                            <button 
                                                key={idx} 
                                                onClick={() => setFotoModal(prev => ({ ...prev, indice: idx }))}
                                                className={`w-12 h-12 rounded overflow-hidden border-2 ${idx === fotoModal.indice ? 'border-white' : 'border-transparent opacity-60 hover:opacity-100'}`}
                                            >
                                                <img 
                                                    src={typeof foto === 'string' ? foto : foto?.url || foto?.link} 
                                                    className="w-full h-full object-cover"
                                                    alt={`Thumb ${idx + 1}`}
                                                />
                                            </button>
                                        ))}
                                    </div>
                                )}
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
