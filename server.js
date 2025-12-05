<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sistema Tutts - Solicitações e Saque Emergencial</title>
  
  <!-- PWA Meta Tags -->
  <meta name="description" content="Sistema Tutts - Gestão de Solicitações, Saques e Disponibilidade de Entregadores">
  <meta name="theme-color" content="#7c3aed">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="apple-mobile-web-app-title" content="Tutts">
  <link rel="manifest" href="/manifest.json">
  <link rel="apple-touch-icon" href="/icon-192.png">
  
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    @keyframes slideIn { from { transform: translateX(100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
    .toast { animation: slideIn 0.3s ease-out; }
    .row-green { background-color: #dcfce7 !important; border-left: 4px solid #22c55e !important; }
    .row-red { background-color: #fee2e2 !important; border-left: 4px solid #ef4444 !important; }
    
    /* PWA Install Banner */
    .pwa-install-banner {
      animation: slideUp 0.5s ease-out;
    }
    @keyframes slideUp {
      from { transform: translateY(100%); opacity: 0; }
      to { transform: translateY(0); opacity: 1; }
    }
  </style>
</head>
<body>
  <div id="root"></div>
  <script src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
  <script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
  <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
  
  <script type="text/babel">
    const { useState, useEffect } = React;
    const API_URL = 'https://tutts-backend-production.up.railway.app/api';

    // ========== COMPONENTES UTILITÁRIOS ==========
    const Toast = ({ message, type }) => (
      <div className={`fixed top-4 right-4 z-50 px-6 py-4 rounded-lg shadow-2xl toast ${type === 'success' ? 'bg-green-600' : 'bg-red-600'} text-white font-semibold flex items-center gap-3`}>
        <span className="text-2xl">{type === 'success' ? '✓' : '✗'}</span>
        <span>{message}</span>
      </div>
    );

    const LoadingOverlay = ({ message = 'Carregando...' }) => (
      <div className="fixed inset-0 bg-black bg-opacity-30 z-50 flex items-center justify-center">
        <div className="bg-white rounded-xl p-6 shadow-2xl flex flex-col items-center gap-3">
          <div className="w-10 h-10 border-4 border-purple-600 border-t-transparent rounded-full animate-spin"></div>
          <p className="text-gray-700 font-semibold">{message}</p>
        </div>
      </div>
    );

    const ImageModal = ({ imageUrl, onClose }) => (
      <div className="fixed inset-0 bg-black bg-opacity-75 z-50 flex items-center justify-center p-4" onClick={onClose}>
        <div className="relative max-w-4xl max-h-screen">
          <button onClick={onClose} className="absolute -top-10 right-0 text-white text-3xl hover:text-gray-300">✕</button>
          <img src={imageUrl} alt="Expandido" className="max-w-full max-h-screen rounded-lg shadow-2xl" onClick={e => e.stopPropagation()} />
        </div>
      </div>
    );

    // ========== GRÁFICO PIE CHART ==========
    const PieChart = ({ data, title }) => {
      const total = data.reduce((sum, item) => sum + item.value, 0);
      if (total === 0) return (
        <div className="bg-white rounded-xl shadow p-6">
          <h3 className="text-lg font-semibold mb-4">{title}</h3>
          <p className="text-gray-500 text-center py-8">Sem dados disponíveis</p>
        </div>
      );

      let currentAngle = 0;
      const slices = data.map((item, index) => {
        const percentage = (item.value / total) * 100;
        const angle = (percentage / 100) * 360;
        const startAngle = currentAngle;
        currentAngle += angle;
        const x1 = 100 + 90 * Math.cos((startAngle - 90) * Math.PI / 180);
        const y1 = 100 + 90 * Math.sin((startAngle - 90) * Math.PI / 180);
        const x2 = 100 + 90 * Math.cos((currentAngle - 90) * Math.PI / 180);
        const y2 = 100 + 90 * Math.sin((currentAngle - 90) * Math.PI / 180);
        const largeArc = angle > 180 ? 1 : 0;
        return { ...item, path: `M 100 100 L ${x1} ${y1} A 90 90 0 ${largeArc} 1 ${x2} ${y2} Z`, percentage: percentage.toFixed(1) };
      });

      return (
        <div className="bg-white rounded-xl shadow p-6">
          <h3 className="text-lg font-semibold mb-4">{title}</h3>
          <div className="flex flex-col md:flex-row items-center gap-6">
            <svg viewBox="0 0 200 200" className="w-48 h-48">
              {slices.map((s, i) => <path key={i} d={s.path} fill={s.color} className="hover:opacity-80 transition-opacity cursor-pointer" />)}
            </svg>
            <div className="flex-1 space-y-2">
              {slices.map((s, i) => (
                <div key={i} className="flex items-center gap-2">
                  <div className="w-4 h-4 rounded" style={{backgroundColor: s.color}}></div>
                  <span className="text-sm flex-1">{s.label}</span>
                  <span className="font-semibold">{s.value}</span>
                  <span className="text-gray-500 text-sm">({s.percentage}%)</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      );
    };

    // ========== GRÁFICO DE STATUS ==========
    const StatusPieChart = ({ submissions }) => {
      const statusCount = {
        pendente: submissions.filter(s => s.status === 'pendente').length,
        aprovada: submissions.filter(s => s.status === 'aprovada').length,
        rejeitada: submissions.filter(s => s.status === 'rejeitada').length
      };
      const total = submissions.length;
      const data = [
        { label: 'Pendentes', value: statusCount.pendente, color: '#eab308' },
        { label: 'Aprovadas', value: statusCount.aprovada, color: '#22c55e' },
        { label: 'Rejeitadas', value: statusCount.rejeitada, color: '#ef4444' }
      ].filter(d => d.value > 0);

      let currentAngle = 0;
      return (
        <div className="bg-white rounded-xl shadow p-6">
          <h2 className="text-lg font-semibold mb-4">📈 Distribuição por Status</h2>
          {total === 0 ? <p className="text-gray-500">Nenhuma solicitação</p> : (
            <div className="flex flex-col md:flex-row items-center gap-6">
              <svg viewBox="0 0 200 200" className="w-48 h-48">
                {data.map((item, index) => {
                  const angle = (item.value / total) * 360;
                  const startAngle = currentAngle;
                  currentAngle += angle;
                  const x1 = 100 + 90 * Math.cos((startAngle - 90) * Math.PI / 180);
                  const y1 = 100 + 90 * Math.sin((startAngle - 90) * Math.PI / 180);
                  const x2 = 100 + 90 * Math.cos((startAngle + angle - 90) * Math.PI / 180);
                  const y2 = 100 + 90 * Math.sin((startAngle + angle - 90) * Math.PI / 180);
                  const largeArc = angle > 180 ? 1 : 0;
                  return <path key={index} d={`M 100 100 L ${x1} ${y1} A 90 90 0 ${largeArc} 1 ${x2} ${y2} Z`} fill={item.color} stroke="white" strokeWidth="2" />;
                })}
                <circle cx="100" cy="100" r="50" fill="white" />
                <text x="100" y="95" textAnchor="middle" className="text-2xl font-bold" fill="#1f2937">{total}</text>
                <text x="100" y="110" textAnchor="middle" className="text-xs" fill="#6b7280">Total</text>
              </svg>
              <div className="flex-1 space-y-2">
                {data.map((item, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <div className="w-4 h-4 rounded" style={{backgroundColor: item.color}}></div>
                    <span className="text-sm flex-1">{item.label}</span>
                    <span className="font-semibold">{item.value}</span>
                    <span className="text-gray-500 text-sm">({((item.value / total) * 100).toFixed(1)}%)</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      );
    };

    // ========== GRÁFICO DE MOTIVOS ==========
    const MotivosPieChart = ({ submissions }) => {
      const motivos = {};
      submissions.forEach(s => { motivos[s.motivo] = (motivos[s.motivo] || 0) + 1; });
      const colors = ['#7c3aed', '#2563eb', '#059669', '#dc2626', '#ea580c', '#8b5cf6'];
      const total = submissions.length;
      const data = Object.entries(motivos).map(([motivo, count], index) => ({
        motivo, count, percentage: ((count / total) * 100).toFixed(1), color: colors[index % colors.length]
      }));

      let currentAngle = 0;
      return (
        <div className="bg-white rounded-xl shadow p-6">
          <h2 className="text-lg font-semibold mb-4">📊 Distribuição por Motivo</h2>
          {total === 0 ? <p className="text-gray-500">Nenhuma solicitação</p> : (
            <div className="flex flex-col md:flex-row items-center gap-6">
              <svg viewBox="0 0 200 200" className="w-48 h-48">
                {data.map((item, index) => {
                  const angle = (item.count / total) * 360;
                  const startAngle = currentAngle;
                  currentAngle += angle;
                  const x1 = 100 + 90 * Math.cos((startAngle - 90) * Math.PI / 180);
                  const y1 = 100 + 90 * Math.sin((startAngle - 90) * Math.PI / 180);
                  const x2 = 100 + 90 * Math.cos((startAngle + angle - 90) * Math.PI / 180);
                  const y2 = 100 + 90 * Math.sin((startAngle + angle - 90) * Math.PI / 180);
                  const largeArc = angle > 180 ? 1 : 0;
                  return <path key={index} d={`M 100 100 L ${x1} ${y1} A 90 90 0 ${largeArc} 1 ${x2} ${y2} Z`} fill={item.color} stroke="white" strokeWidth="2" />;
                })}
                <circle cx="100" cy="100" r="50" fill="white" />
                <text x="100" y="95" textAnchor="middle" className="text-2xl font-bold" fill="#1f2937">{total}</text>
                <text x="100" y="110" textAnchor="middle" className="text-xs" fill="#6b7280">Total</text>
              </svg>
              <div className="flex-1 space-y-2">
                {data.map((item, i) => (
                  <div key={i} className="flex items-center gap-3">
                    <div className="w-4 h-4 rounded" style={{ backgroundColor: item.color }} />
                    <div className="flex-1">
                      <p className="text-sm font-medium text-gray-800 truncate">{item.motivo}</p>
                      <p className="text-xs text-gray-500">{item.count} ({item.percentage}%)</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      );
    };

    // ========== RANKING DE TÉCNICOS ==========
    const TechRanking = ({ submissions }) => {
      const stats = {};
      submissions.forEach(s => {
        const tech = s.fullName || 'Desconhecido';
        if (!stats[tech]) stats[tech] = { total: 0, aprovadas: 0, rejeitadas: 0, pendentes: 0 };
        stats[tech].total++;
        if (s.status === 'aprovada') stats[tech].aprovadas++;
        else if (s.status === 'rejeitada') stats[tech].rejeitadas++;
        else stats[tech].pendentes++;
      });

      const ranking = Object.entries(stats).map(([name, data]) => ({
        name, ...data, aprovacao: data.total > 0 ? ((data.aprovadas / data.total) * 100).toFixed(1) : 0
      })).sort((a, b) => b.total - a.total);

      return (
        <div className="bg-white rounded-xl shadow p-6">
          <h3 className="text-lg font-semibold mb-4">🏆 Ranking de Profissionais</h3>
          {ranking.length === 0 ? <p className="text-gray-500 text-center py-8">Sem dados</p> : (
            <div className="space-y-3">
              {ranking.map((tech, i) => (
                <div key={i} className="flex items-center gap-4 p-3 bg-gray-50 rounded-lg hover:bg-gray-100 transition">
                  <div className={`text-2xl font-bold w-8 ${i === 0 ? 'text-yellow-500' : i === 1 ? 'text-gray-400' : i === 2 ? 'text-orange-600' : 'text-gray-400'}`}>{i + 1}º</div>
                  <div className="flex-1">
                    <p className="font-semibold text-gray-800">{tech.name}</p>
                    <div className="flex gap-4 text-sm text-gray-600 mt-1">
                      <span>Total: <b>{tech.total}</b></span>
                      <span className="text-green-600">✓ {tech.aprovadas}</span>
                      <span className="text-red-600">✗ {tech.rejeitadas}</span>
                      <span className="text-yellow-600">⏳ {tech.pendentes}</span>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-2xl font-bold text-purple-600">{tech.aprovacao}%</div>
                    <div className="text-xs text-gray-500">aprovação</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      );
    };

    // ========== MODAL QR CODE PIX ==========
    const PixQRCodeModal = ({ data, onClose }) => {
      if (!data) return null;
      
      // State para forçar regeneração do QR Code
      const [qrTimestamp, setQrTimestamp] = React.useState(Date.now());
      
      // Gera o payload PIX (BR Code) - Padrão EMV/BACEN
      const gerarPayloadPix = (chave, valor, nome, cidade) => {
        // Normaliza removendo acentos e caracteres especiais
        const normalizar = (str, max) => {
          return (str || '')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-zA-Z0-9 ]/g, '')
            .toUpperCase()
            .substring(0, max);
        };
        
        // Limpa a chave PIX conforme o tipo
        const limparChave = (ch) => {
          if (!ch) return '';
          const chTrim = ch.trim();
          const apenasNumeros = chTrim.replace(/[^0-9]/g, '');
          
          // Email: contém @
          if (chTrim.includes('@')) {
            return chTrim.toLowerCase();
          }
          
          // Telefone com +55 já incluso
          if (chTrim.startsWith('+55')) {
            return chTrim;
          }
          
          // Telefone com + mas sem 55
          if (chTrim.startsWith('+')) {
            return chTrim;
          }
          
          // CPF: 11 dígitos (sem formatação)
          if (apenasNumeros.length === 11) {
            // Verifica se parece telefone (começa com DDD válido e 9)
            const ddd = parseInt(apenasNumeros.substring(0, 2));
            if (ddd >= 11 && ddd <= 99 && apenasNumeros[2] === '9') {
              return '+55' + apenasNumeros;
            }
            return apenasNumeros; // CPF
          }
          
          // CNPJ: 14 dígitos
          if (apenasNumeros.length === 14) {
            return apenasNumeros;
          }
          
          // Telefone: 10 ou 11 dígitos com formatação (parênteses, hífen)
          if (chTrim.includes('(') || chTrim.includes(')') || chTrim.includes('-')) {
            if (apenasNumeros.length === 10 || apenasNumeros.length === 11) {
              return '+55' + apenasNumeros;
            }
          }
          
          // Chave aleatória UUID
          if (/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(chTrim)) {
            return chTrim.toLowerCase();
          }
          
          return chTrim;
        };
        
        // Formata o valor com ponto como separador decimal
        const formatarValor = (v) => {
          if (!v || v <= 0) return '';
          return v.toFixed(2);
        };
        
        // Cria campo EMV (ID + Tamanho + Valor)
        const emv = (id, valor) => {
          if (!valor) return '';
          const tamanho = valor.length.toString().padStart(2, '0');
          return id + tamanho + valor;
        };
        
        // Calcula CRC16 CCITT-FALSE para PIX
        const crc16 = (str) => {
          let crc = 0xFFFF;
          for (let i = 0; i < str.length; i++) {
            crc ^= str.charCodeAt(i) << 8;
            for (let j = 0; j < 8; j++) {
              if (crc & 0x8000) {
                crc = ((crc << 1) ^ 0x1021) & 0xFFFF;
              } else {
                crc = (crc << 1) & 0xFFFF;
              }
            }
          }
          return crc.toString(16).toUpperCase().padStart(4, '0');
        };
        
        // Limpa a chave antes de usar
        const chaveLimpa = limparChave(chave);
        
        // Monta Merchant Account Info (ID 26)
        // GUI em minúsculas conforme padrão oficial BACEN
        const gui = emv('00', 'br.gov.bcb.pix');
        const chaveField = emv('01', chaveLimpa);
        const merchantAccount = emv('26', gui + chaveField);
        
        // Monta payload PIX Estático (formato simplificado que funciona no Cora e Inter)
        let payload = '';
        payload += emv('00', '01');                           // Payload Format Indicator
        payload += merchantAccount;                            // Merchant Account (PIX)
        payload += emv('52', '0000');                         // MCC (não informado)
        payload += emv('53', '986');                          // Currency (BRL)
        
        const valorFormatado = formatarValor(valor);
        if (valorFormatado) {
          payload += emv('54', valorFormatado);               // Amount
        }
        
        payload += emv('58', 'BR');                           // Country
        payload += emv('59', normalizar(nome, 25));           // Merchant Name
        payload += emv('60', normalizar(cidade, 15));         // Merchant City
        payload += '6304';                                     // CRC placeholder (ID 63, tamanho 04)
        
        // Calcula e adiciona CRC no final
        const crcValue = crc16(payload);
        payload += crcValue;
        
        return payload;
      };
      
      const payload = gerarPayloadPix(data.pix_key, data.valor, data.nome, 'SAO PAULO');
      
      // URL do QR Code via qrserver API
      const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(payload)}`;
      
      const copiarPayload = () => {
        navigator.clipboard.writeText(payload);
        alert('✅ Código PIX copiado!');
      };
      
      const regenerarQRCode = () => {
        setQrTimestamp(Date.now());
      };
      
      return (
        <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4" onClick={onClose}>
          <div className="bg-white rounded-xl shadow-2xl p-6 max-w-md w-full" onClick={e => e.stopPropagation()}>
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-xl font-bold text-gray-800 flex items-center gap-2">
                💠 QR Code PIX
              </h3>
              <button onClick={onClose} className="text-gray-500 hover:text-gray-700 text-2xl">×</button>
            </div>
            
            {/* Dados do pagamento */}
            <div className="bg-gray-50 rounded-lg p-4 mb-4 space-y-2">
              <p className="text-sm"><span className="text-gray-600">Nome:</span> <strong>{data.nome}</strong></p>
              <p className="text-sm"><span className="text-gray-600">Chave PIX:</span> <strong className="font-mono text-xs break-all">{data.pix_key}</strong></p>
              <p className="text-sm"><span className="text-gray-600">Valor:</span> <strong className="text-green-600 text-lg">R$ {data.valor?.toFixed(2)}</strong></p>
            </div>
            
            {/* QR Code */}
            <div className="flex justify-center mb-4">
              <img 
                src={qrCodeUrl} 
                alt="QR Code PIX" 
                className="w-64 h-64 border-4 border-gray-200 rounded-lg bg-white"
                key={qrTimestamp}
              />
            </div>
            
            {/* Timestamp da geração */}
            <p className="text-xs text-gray-400 text-center mb-3">
              Gerado em: {new Date(qrTimestamp).toLocaleString('pt-BR')}
            </p>
            
            {/* Botões */}
            <div className="flex gap-2 mb-3">
              <button 
                onClick={copiarPayload} 
                className="flex-1 px-4 py-3 bg-green-600 text-white rounded-lg font-semibold hover:bg-green-700 flex items-center justify-center gap-2"
              >
                📋 Copiar Copia e Cola
              </button>
              <button 
                onClick={() => navigator.clipboard.writeText(data.pix_key)} 
                className="px-4 py-3 bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700"
                title="Copiar chave PIX"
              >
                🔑
              </button>
            </div>
            
            {/* Botão Regenerar */}
            <button 
              onClick={regenerarQRCode} 
              className="w-full px-4 py-2 bg-gray-200 text-gray-700 rounded-lg font-semibold hover:bg-gray-300 flex items-center justify-center gap-2"
            >
              🔄 Gerar Novo QR Code
            </button>
            
            <p className="text-xs text-gray-500 text-center mt-4">
              Escaneie o QR Code ou use o botão "Copiar Copia e Cola"
            </p>
            
            {/* Debug - Payload - SEMPRE VISÍVEL */}
            <div className="mt-4 p-3 bg-yellow-50 border border-yellow-200 rounded-lg">
              <p className="text-xs font-semibold text-yellow-800 mb-2">🔍 Payload PIX (para debug):</p>
              <pre className="text-[10px] break-all whitespace-pre-wrap font-mono bg-white p-2 rounded border">{payload}</pre>
              <button 
                onClick={() => { navigator.clipboard.writeText(payload); alert('Payload copiado!'); }}
                className="mt-2 text-xs bg-yellow-500 text-white px-3 py-1 rounded hover:bg-yellow-600"
              >
                📋 Copiar Payload
              </button>
            </div>
          </div>
        </div>
      );
    };

    // ========== COMPONENTE PRINCIPAL ==========
    const App = () => {
      const [user, setUser] = useState(null);
      const [loading, setLoading] = useState(false);
      const [globalLoading, setGlobalLoading] = useState(false);
      const [toast, setToast] = useState(null);
      const [formData, setFormData] = useState({});
      const [imageModal, setImageModal] = useState(null);
      const [pixQRModal, setPixQRModal] = useState(null); // Estado para modal QR Code PIX
      const [lastActivity, setLastActivity] = useState(Date.now());
      const [lastUpdate, setLastUpdate] = useState(null);
      const [isPolling, setIsPolling] = useState(false);

      // Estados - Solicitações
      const [submissions, setSubmissions] = useState([]);
      const [users, setUsers] = useState([]);

      // Estados - Saque Emergencial
      const [termsAccepted, setTermsAccepted] = useState(false);
      const [financialData, setFinancialData] = useState(null);
      const [financialLogs, setFinancialLogs] = useState([]);
      const [editandoDados, setEditandoDados] = useState(false);
      const [withdrawals, setWithdrawals] = useState([]);
      const [allWithdrawals, setAllWithdrawals] = useState([]);
      const [gratuities, setGratuities] = useState([]);
      const [userGratuities, setUserGratuities] = useState([]);
      const [restrictedList, setRestrictedList] = useState([]);
      const [dashboardData, setDashboardData] = useState({});
      
      // Estados - Indicações
      const [promocoes, setPromocoes] = useState([]);
      const [indicacoes, setIndicacoes] = useState([]);
      const [minhasIndicacoes, setMinhasIndicacoes] = useState([]);
      
      // Estados - Promoções Novatos
      const [promocoesNovatos, setPromocoesNovatos] = useState([]);
      const [inscricoesNovatos, setInscricoesNovatos] = useState([]);
      const [minhasInscricoesNovatos, setMinhasInscricoesNovatos] = useState([]);
      
      // Estados - Planilha Google Sheets (Profissionais)
      const [profissionaisSheet, setProfissionaisSheet] = useState([]);
      const [sheetLoading, setSheetLoading] = useState(false);
      const [sheetError, setSheetError] = useState(null);
      const SHEET_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQTbc5J8j85MlYGrjWajG33cTDd6TEpYur5hgNcYUwmtra8jh3Nfsrzm-0GNJO6wCYEZAGEHxw807o7/pub?gid=0&single=true&output=tsv';
      
      // Estado - Admin Master (módulo ativo)
      const [adminMasterModule, setAdminMasterModule] = useState('solicitacoes'); // 'solicitacoes', 'financeiro' ou 'disponibilidade'
      
      // Estados - Quiz de Procedimentos
      const [quizConfig, setQuizConfig] = useState({
        titulo: 'Acerte os procedimentos e ganhe saque gratuito de R$ 500,00',
        imagens: [null, null, null, null],
        perguntas: [
          { texto: '', resposta: true },
          { texto: '', resposta: true },
          { texto: '', resposta: true },
          { texto: '', resposta: true },
          { texto: '', resposta: true }
        ],
        valor_gratuidade: 500.00,
        ativo: false
      });
      const [quizRespostas, setQuizRespostas] = useState([]);
      const [quizJaRespondeu, setQuizJaRespondeu] = useState(false);
      const [quizDadosUsuario, setQuizDadosUsuario] = useState(null); // Dados da resposta do usuário
      const [quizEtapa, setQuizEtapa] = useState(0); // 0=não iniciado, 1=carrossel, 2=perguntas, 3=resultado
      const [quizCarrosselIndex, setQuizCarrosselIndex] = useState(0);
      const [quizRespostasUsuario, setQuizRespostasUsuario] = useState([null, null, null, null, null]);
      const [quizResultado, setQuizResultado] = useState(null);
      const [quizExpandido, setQuizExpandido] = useState(false); // Controle do dropdown
      
      // Estados para aba Horários de Atendimento
      const [horariosData, setHorariosData] = useState({ horarios: [], especiais: [], loading: true });
      // Estados para aba Avisos
      const [avisosData, setAvisosData] = useState({ avisos: [], loading: true });
      // Estados para verificação de horário do usuário
      const [horarioVerificado, setHorarioVerificado] = useState(null);
      const [sliderValue, setSliderValue] = useState(0);
      const [avisosUsuario, setAvisosUsuario] = useState([]);
      const [horarioAceito, setHorarioAceito] = useState(false);

      // Verifica se usuário é novato (COD >= 14000) e se está dentro dos 30 dias
      const isNovato = () => {
        if (!user || !user.codProfissional) return false;
        const numCod = parseInt(user.codProfissional.replace(/\D/g, ''));
        if (numCod < 14000) return false;
        
        // Verifica se passou 30 dias desde o cadastro
        if (user.createdAt) {
          const dataCadastro = new Date(user.createdAt);
          const agora = new Date();
          const diffDias = Math.floor((agora - dataCadastro) / (1000 * 60 * 60 * 24));
          if (diffDias > 30) return false;
        }
        
        return true;
      };
      
      // Calcula dias restantes para exibir
      const diasRestantesNovato = () => {
        if (!user || !user.createdAt) return 0;
        const dataCadastro = new Date(user.createdAt);
        const agora = new Date();
        const diffDias = Math.floor((agora - dataCadastro) / (1000 * 60 * 60 * 24));
        return Math.max(0, 30 - diffDias);
      };

      const showToast = (message, type = 'success') => {
        setToast({ message, type });
        setTimeout(() => setToast(null), 3000);
      };

      // Auto-logout 15 min
      useEffect(() => {
        if (!user) return;
        const TIMEOUT = 15 * 60 * 1000;
        const reset = () => setLastActivity(Date.now());
        const events = ['mousedown', 'mousemove', 'keydown', 'scroll', 'touchstart', 'click'];
        events.forEach(e => window.addEventListener(e, reset));
        const check = setInterval(() => {
          if (Date.now() - lastActivity > TIMEOUT) {
            showToast('⏰ Sessão expirada', 'error');
            setTimeout(() => { setUser(null); setFormData({}); }, 1500);
          }
        }, 30000);
        return () => { events.forEach(e => window.removeEventListener(e, reset)); clearInterval(check); };
      }, [user, lastActivity]);

      // Carregar planilha quando abrir tela de cadastro
      useEffect(() => {
        if (!user && formData.view === 'register' && profissionaisSheet.length === 0) {
          loadProfissionaisSheet();
        }
      }, [formData.view]);

      // Auto-preencher nome quando digitar código na tela de cadastro
      useEffect(() => {
        if (formData.view === 'register' && formData.cod && profissionaisSheet.length > 0) {
          const nome = buscarNomePorCodigo(formData.cod);
          if (nome) {
            setFormData(prev => ({ ...prev, name: nome, codValido: true }));
          } else {
            setFormData(prev => ({ ...prev, name: '', codValido: false }));
          }
        }
      }, [formData.cod, formData.view, profissionaisSheet]);

      // Carregar dados ao logar
      useEffect(() => {
        if (!user) return;
        loadSubmissions();
        if (user.role === 'admin' || user.role === 'admin_master') loadUsers();
        if (user.role === 'user') { checkTerms(); loadUserWithdrawals(); loadUserGratuities(); loadPromocoesAtivas(); loadMinhasIndicacoes(); loadPromocoesNovatosAtivas(); loadMinhasInscricoesNovatos(); loadQuizConfig(); verificarQuizRespondido(); }
        if (user.role === 'admin_financeiro' || user.role === 'admin_master') { loadAllWithdrawals(); loadAllGratuities(); loadRestricted(); loadDashboard(); loadPromocoes(); loadIndicacoes(); loadPromocoesNovatos(); loadInscricoesNovatos(); loadQuizConfig(); loadQuizRespostas(); loadUsers(); }
      }, [user]);

      // ========== POLLING INTELIGENTE - APENAS ABA ATIVA ==========
      useEffect(() => {
        if (!user || user.role !== 'admin_financeiro') return;
        
        const POLLING_INTERVAL = 60000; // 60 segundos
        
        const pollActiveTab = async () => {
          const activeTab = formData.finTab || 'solicitacoes';
          setIsPolling(true);
          
          try {
            switch(activeTab) {
              case 'solicitacoes':
                await loadAllWithdrawals();
                break;
              case 'validacao':
                await loadAllWithdrawals();
                break;
              case 'gratuidades':
                await loadAllGratuities();
                break;
              case 'restritos':
                await loadRestricted();
                break;
              case 'indicacoes':
                await loadPromocoes();
                await loadIndicacoes();
                break;
              case 'promo-novatos':
                await loadPromocoesNovatos();
                await loadInscricoesNovatos();
                await loadQuizRespostas();
                break;
              case 'resumo':
                await loadDashboard();
                break;
              default:
                break;
            }
            setLastUpdate(new Date());
          } catch (err) {
            console.error('Erro no polling:', err);
          }
          setIsPolling(false);
        };
        
        const interval = setInterval(pollActiveTab, POLLING_INTERVAL);
        
        // Cleanup ao desmontar ou trocar de aba
        return () => clearInterval(interval);
      }, [user, formData.finTab]);

      // ========== POLLING PARA ADMIN MASTER (Submissões de Ajuste) ==========
      useEffect(() => {
        if (!user || user.role !== 'admin') return;
        
        const POLLING_INTERVAL = 60000; // 60 segundos
        
        const pollSubmissions = async () => {
          setIsPolling(true);
          try {
            await loadSubmissions();
            setLastUpdate(new Date());
          } catch (err) {
            console.error('Erro no polling:', err);
          }
          setIsPolling(false);
        };
        
        const interval = setInterval(pollSubmissions, POLLING_INTERVAL);
        
        return () => clearInterval(interval);
      }, [user]);

      // ========== POLLING PARA DISPONIBILIDADE (tempo real para todos admins) ==========
      useEffect(() => {
        if (!user || !['admin', 'admin_master'].includes(user.role)) return;
        if (formData.adminTab !== 'disponibilidade') return;
        
        const POLLING_INTERVAL = 10000; // 10 segundos - mais frequente para tempo real
        
        const pollDisponibilidade = async () => {
          try {
            const res = await fetch(`${API_URL}/disponibilidade`);
            if (!res.ok) return;
            const data = await res.json();
            setFormData(f => ({...f, dispData: data}));
            console.log('🔄 Disponibilidade atualizada em tempo real');
          } catch (err) {
            console.error('Erro no polling disponibilidade:', err);
          }
        };
        
        const interval = setInterval(pollDisponibilidade, POLLING_INTERVAL);
        
        return () => clearInterval(interval);
      }, [user, formData.adminTab]);

      // ========== CARREGAR HORÁRIOS DE ATENDIMENTO ==========
      useEffect(() => {
        if (!user || !['admin', 'admin_master'].includes(user.role)) return;
        if (formData.finTab !== 'horarios') return;
        
        const carregarHorarios = async () => {
          try {
            const [horariosRes, especiaisRes] = await Promise.all([
              fetch(`${API_URL}/horarios`).then(r => r.json()),
              fetch(`${API_URL}/horarios/especiais`).then(r => r.json())
            ]);
            setHorariosData({
              horarios: horariosRes,
              especiais: especiaisRes,
              loading: false
            });
          } catch (err) {
            console.error('Erro ao carregar horários:', err);
            setHorariosData(prev => ({...prev, loading: false}));
          }
        };
        carregarHorarios();
      }, [user, formData.finTab]);

      // ========== CARREGAR AVISOS ==========
      useEffect(() => {
        if (!user || !['admin', 'admin_master'].includes(user.role)) return;
        if (formData.finTab !== 'avisos') return;
        
        const carregarAvisos = async () => {
          try {
            const res = await fetch(`${API_URL}/avisos`);
            const data = await res.json();
            setAvisosData({ avisos: data, loading: false });
          } catch (err) {
            console.error('Erro ao carregar avisos:', err);
            setAvisosData(prev => ({...prev, loading: false}));
          }
        };
        carregarAvisos();
      }, [user, formData.finTab]);

      // ========== VERIFICAR HORÁRIO PARA USUÁRIO (SAQUE) ==========
      useEffect(() => {
        if (!user || user.role !== 'user') return;
        if (formData.userTab !== 'saque') return;
        
        // Resetar estados ao entrar na aba de saque
        setHorarioAceito(false);
        setSliderValue(0);
        setHorarioVerificado(null);
        
        const verificarHorario = async () => {
          try {
            const [horRes, avisosRes] = await Promise.all([
              fetch(`${API_URL}/horarios/verificar`).then(r => r.json()),
              fetch(`${API_URL}/avisos?ativos=true`).then(r => r.json())
            ]);
            setHorarioVerificado(horRes);
            const avisosFiltrados = avisosRes.filter(a => 
              !a.exibir_fora_horario || (a.exibir_fora_horario && !horRes.dentroHorario)
            );
            setAvisosUsuario(avisosFiltrados);
          } catch (err) {
            console.error('Erro ao verificar horário:', err);
            setHorarioVerificado({ dentroHorario: true }); // Fallback: permitir
          }
        };
        verificarHorario();
      }, [user, formData.userTab]);

      // Carregar pixTipo quando financialData mudar
      useEffect(() => {
        if (financialData && financialData.pix_tipo) {
          setFormData(prev => ({
            ...prev, 
            pixTipo: financialData.pix_tipo,
            finPix: financialData.pix_key || '',
            finName: financialData.full_name || '',
            finCpf: financialData.cpf || ''
          }));
        }
      }, [financialData]);

      // ========== FUNÇÕES DE CARREGAMENTO ==========
      
      // Carregar profissionais da planilha Google Sheets
      const loadProfissionaisSheet = async () => {
        setSheetLoading(true);
        setSheetError(null);
        try {
          const res = await fetch(SHEET_URL);
          const text = await res.text();
          const lines = text.split('\n').filter(l => l.trim());
          const profissionais = [];
          
          // Pular header (primeira linha)
          for (let i = 1; i < lines.length; i++) {
            const cols = lines[i].split('\t');
            const codigo = cols[0]?.trim();
            const nome = cols[1]?.trim();
            if (codigo && nome) {
              profissionais.push({ codigo, nome });
            }
          }
          
          setProfissionaisSheet(profissionais);
          console.log(`📊 Planilha carregada: ${profissionais.length} profissionais`);
        } catch (err) {
          console.error('Erro ao carregar planilha:', err);
          setSheetError('Erro ao carregar lista de profissionais');
        }
        setSheetLoading(false);
      };
      
      // Buscar nome pelo código na planilha
      const buscarNomePorCodigo = (codigo) => {
        if (!codigo || profissionaisSheet.length === 0) return null;
        const prof = profissionaisSheet.find(p => p.codigo === codigo.toString());
        return prof ? prof.nome : null;
      };
      
      const loadSubmissions = async () => {
        try {
          const query = user.role === 'user' ? `?userId=${user.id}&userCod=${user.cod_profissional}` : '';
          const res = await fetch(`${API_URL}/submissions${query}`);
          const data = await res.json();
          setSubmissions(data.map(s => ({
            ...s, ordemServico: s.ordem_servico, codProfissional: s.user_cod, fullName: s.user_name,
            temImagem: s.tem_imagem, imagemComprovante: null, timestamp: new Date(s.created_at).toLocaleString('pt-BR')
          })));
        } catch (err) { console.error(err); }
      };

      const loadUsers = async () => {
        try {
          const res = await fetch(`${API_URL}/users`);
          const data = await res.json();
          setUsers(data.map(u => ({ codProfissional: u.cod_profissional, fullName: u.full_name, role: u.role, createdAt: new Date(u.created_at).toLocaleString('pt-BR') })));
        } catch (err) { console.error(err); }
      };

      const loadImagem = async (id) => {
        try {
          const res = await fetch(`${API_URL}/submissions/${id}/imagem`);
          const data = await res.json();
          setSubmissions(prev => prev.map(s => s.id === id ? {...s, imagemComprovante: data.imagem} : s));
        } catch (err) { showToast('Erro ao carregar imagem', 'error'); }
      };

      const checkTerms = async () => {
        try {
          const res = await fetch(`${API_URL}/financial/check-terms/${user.cod_profissional}`);
          const data = await res.json();
          setTermsAccepted(data.hasAccepted);
          if (data.hasAccepted) {
            const finRes = await fetch(`${API_URL}/financial/data/${user.cod_profissional}`);
            const finData = await finRes.json();
            setFinancialData(finData.data);
            // Carregar logs de alterações
            loadFinancialLogs();
          }
        } catch (err) { console.error(err); }
      };

      const loadFinancialLogs = async () => {
        try {
          const res = await fetch(`${API_URL}/financial/logs/${user.cod_profissional}`);
          const data = await res.json();
          setFinancialLogs(data);
        } catch (err) { console.error(err); }
      };

      const loadUserWithdrawals = async () => {
        try {
          const res = await fetch(`${API_URL}/withdrawals/user/${user.cod_profissional}`);
          setWithdrawals(await res.json());
        } catch (err) { console.error(err); }
      };

      const loadUserGratuities = async () => {
        try {
          const res = await fetch(`${API_URL}/gratuities/user/${user.cod_profissional}`);
          setUserGratuities(await res.json());
        } catch (err) { console.error(err); }
      };

      const loadAllWithdrawals = async () => {
        try {
          const res = await fetch(`${API_URL}/withdrawals`);
          setAllWithdrawals(await res.json());
        } catch (err) { console.error(err); }
      };

      const loadAllGratuities = async () => {
        try {
          const res = await fetch(`${API_URL}/gratuities`);
          setGratuities(await res.json());
        } catch (err) { console.error(err); }
      };

      const loadRestricted = async () => {
        try {
          const res = await fetch(`${API_URL}/restricted`);
          setRestrictedList(await res.json());
        } catch (err) { console.error(err); }
      };

      const loadDashboard = async () => {
        try {
          const res = await fetch(`${API_URL}/withdrawals/dashboard/conciliacao`);
          setDashboardData(await res.json());
        } catch (err) { console.error(err); }
      };

      const refreshAll = async () => {
        setGlobalLoading(true);
        try {
          await loadSubmissions();
          if (user.role === 'admin' || user.role === 'admin_master') await loadUsers();
          if (user.role === 'user') { await loadUserWithdrawals(); await loadUserGratuities(); await loadPromocoesAtivas(); await loadMinhasIndicacoes(); }
          if (user.role === 'admin_financeiro' || user.role === 'admin_master') { await loadAllWithdrawals(); await loadAllGratuities(); await loadRestricted(); await loadDashboard(); await loadPromocoes(); await loadIndicacoes(); await loadUsers(); }
          showToast('🔄 Atualizado!', 'success');
        } catch (err) { showToast('Erro', 'error'); }
        setGlobalLoading(false);
      };

      // ========== FUNÇÕES DE INDICAÇÕES ==========
      const loadPromocoes = async () => {
        try {
          const res = await fetch(`${API_URL}/promocoes`);
          setPromocoes(await res.json());
        } catch (err) { console.error('Erro ao carregar promoções:', err); }
      };

      // ========== FUNÇÕES DE HORÁRIOS ==========
      const diasSemana = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'];
      
      const atualizarHorario = async (id, dados) => {
        try {
          await fetch(`${API_URL}/horarios/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(dados)
          });
          showToast('✅ Horário atualizado!', 'success');
          const res = await fetch(`${API_URL}/horarios`);
          const horariosAtualizados = await res.json();
          setHorariosData(prev => ({...prev, horarios: horariosAtualizados}));
        } catch (err) {
          showToast('Erro ao atualizar', 'error');
        }
      };
      
      const criarEspecial = async () => {
        const data = formData.novoEspData;
        const descricao = formData.novoEspDesc;
        const fechado = formData.novoEspFechado;
        const horaInicio = formData.novoEspInicio;
        const horaFim = formData.novoEspFim;
        
        if (!data) {
          showToast('Selecione uma data', 'error');
          return;
        }
        
        try {
          await fetch(`${API_URL}/horarios/especiais`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              data,
              descricao: descricao || 'Horário especial',
              hora_inicio: horaInicio,
              hora_fim: horaFim,
              fechado
            })
          });
          showToast('✅ Horário especial criado!', 'success');
          setFormData(f => ({...f, novoEspData: '', novoEspDesc: '', novoEspFechado: false, novoEspInicio: '09:00', novoEspFim: '18:00'}));
          const res = await fetch(`${API_URL}/horarios/especiais`);
          const especiaisAtualizados = await res.json();
          setHorariosData(prev => ({...prev, especiais: especiaisAtualizados}));
        } catch (err) {
          showToast('Erro ao criar', 'error');
        }
      };
      
      const removerEspecial = async (id) => {
        if (!confirm('Remover este horário especial?')) return;
        try {
          await fetch(`${API_URL}/horarios/especiais/${id}`, { method: 'DELETE' });
          showToast('✅ Removido!', 'success');
          const res = await fetch(`${API_URL}/horarios/especiais`);
          const especiaisAtualizados = await res.json();
          setHorariosData(prev => ({...prev, especiais: especiaisAtualizados}));
        } catch (err) {
          showToast('Erro', 'error');
        }
      };

      // ========== FUNÇÕES DE AVISOS ==========
      const criarAviso = async () => {
        const titulo = formData.novoAvisoTitulo;
        const mensagem = formData.novoAvisoMensagem;
        const tipo = formData.novoAvisoTipo || 'info';
        const exibirFora = formData.novoAvisoExibirFora || false;
        
        if (!titulo || !mensagem) {
          showToast('Preencha título e mensagem', 'error');
          return;
        }
        
        try {
          await fetch(`${API_URL}/avisos`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              titulo,
              mensagem,
              tipo,
              exibir_fora_horario: exibirFora
            })
          });
          showToast('✅ Aviso criado!', 'success');
          setFormData(f => ({...f, novoAvisoTitulo: '', novoAvisoMensagem: '', novoAvisoTipo: 'info', novoAvisoExibirFora: false}));
          const res = await fetch(`${API_URL}/avisos`);
          setAvisosData({ avisos: await res.json(), loading: false });
        } catch (err) {
          showToast('Erro ao criar', 'error');
        }
      };
      
      const toggleAviso = async (aviso) => {
        try {
          await fetch(`${API_URL}/avisos/${aviso.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({...aviso, ativo: !aviso.ativo})
          });
          const res = await fetch(`${API_URL}/avisos`);
          setAvisosData({ avisos: await res.json(), loading: false });
        } catch (err) {
          showToast('Erro', 'error');
        }
      };
      
      const removerAviso = async (id) => {
        if (!confirm('Remover este aviso permanentemente?')) return;
        try {
          await fetch(`${API_URL}/avisos/${id}`, { method: 'DELETE' });
          showToast('✅ Removido!', 'success');
          const res = await fetch(`${API_URL}/avisos`);
          setAvisosData({ avisos: await res.json(), loading: false });
        } catch (err) {
          showToast('Erro', 'error');
        }
      };
      
      // Função auxiliar para formatar próximo horário
      const formatarProximoHorario = () => {
        if (!horarioVerificado?.proximoHorario) return 'em breve';
        const prox = horarioVerificado.proximoHorario;
        const data = new Date(prox.data + 'T12:00:00');
        const hoje = new Date();
        hoje.setHours(0,0,0,0);
        const dataProx = new Date(prox.data + 'T00:00:00');
        
        if (dataProx.getTime() === hoje.getTime()) {
          return `hoje às ${prox.inicio}`;
        } else if (dataProx.getTime() === hoje.getTime() + 86400000) {
          return `amanhã às ${prox.inicio}`;
        } else {
          return `${data.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'short' })} às ${prox.inicio}`;
        }
      };

      const loadPromocoesAtivas = async () => {
        try {
          const res = await fetch(`${API_URL}/promocoes/ativas`);
          setPromocoes(await res.json());
        } catch (err) { console.error('Erro ao carregar promoções ativas:', err); }
      };

      const loadIndicacoes = async () => {
        try {
          const res = await fetch(`${API_URL}/indicacoes`);
          setIndicacoes(await res.json());
        } catch (err) { console.error('Erro ao carregar indicações:', err); }
      };

      const loadMinhasIndicacoes = async () => {
        try {
          const res = await fetch(`${API_URL}/indicacoes/usuario/${user.codProfissional}`);
          setMinhasIndicacoes(await res.json());
        } catch (err) { console.error('Erro ao carregar minhas indicações:', err); }
      };

      // === FUNÇÕES PROMOÇÕES NOVATOS ===
      const loadPromocoesNovatos = async () => {
        try {
          const res = await fetch(`${API_URL}/promocoes-novatos`);
          setPromocoesNovatos(await res.json());
        } catch (err) { console.error('Erro ao carregar promoções novatos:', err); }
      };

      const loadPromocoesNovatosAtivas = async () => {
        try {
          const res = await fetch(`${API_URL}/promocoes-novatos/ativas`);
          setPromocoesNovatos(await res.json());
        } catch (err) { console.error('Erro ao carregar promoções novatos ativas:', err); }
      };

      const loadInscricoesNovatos = async () => {
        try {
          // Verificar expiradas primeiro
          await fetch(`${API_URL}/inscricoes-novatos/verificar-expiradas`, { method: 'POST' });
          const res = await fetch(`${API_URL}/inscricoes-novatos`);
          setInscricoesNovatos(await res.json());
        } catch (err) { console.error('Erro ao carregar inscrições novatos:', err); }
      };

      const loadMinhasInscricoesNovatos = async () => {
        try {
          const res = await fetch(`${API_URL}/inscricoes-novatos/usuario/${user.codProfissional}`);
          setMinhasInscricoesNovatos(await res.json());
        } catch (err) { console.error('Erro ao carregar minhas inscrições novatos:', err); }
      };

      const handleCriarPromocaoNovatos = async () => {
        if (!formData.novatosRegiao || !formData.novatosCliente || !formData.novatosValor) {
          showToast('Preencha todos os campos obrigatórios', 'error');
          return;
        }
        setLoading(true);
        try {
          const res = await fetch(`${API_URL}/promocoes-novatos`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              regiao: formData.novatosRegiao,
              cliente: formData.novatosCliente,
              valor_bonus: parseFloat(formData.novatosValor),
              detalhes: formData.novatosDetalhes || null,
              created_by: user.fullName
            })
          });
          if (!res.ok) throw new Error('Erro ao criar promoção');
          showToast('✅ Promoção Novatos criada!', 'success');
          setFormData({ ...formData, novatosRegiao: '', novatosCliente: '', novatosValor: '', novatosDetalhes: '', editPromoNovatos: null });
          await loadPromocoesNovatos();
        } catch (err) {
          showToast(err.message, 'error');
        } finally {
          setLoading(false);
        }
      };

      const handleEditarPromocaoNovatos = async () => {
        setLoading(true);
        try {
          const res = await fetch(`${API_URL}/promocoes-novatos/${formData.editPromoNovatos.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              regiao: formData.novatosRegiao,
              cliente: formData.novatosCliente,
              valor_bonus: parseFloat(formData.novatosValor),
              detalhes: formData.novatosDetalhes || null
            })
          });
          if (!res.ok) throw new Error('Erro ao editar promoção');
          showToast('✅ Promoção atualizada!', 'success');
          setFormData({ ...formData, novatosRegiao: '', novatosCliente: '', novatosValor: '', novatosDetalhes: '', editPromoNovatos: null });
          await loadPromocoesNovatos();
        } catch (err) {
          showToast(err.message, 'error');
        } finally {
          setLoading(false);
        }
      };

      const handleInscreverNovatos = async (promocao) => {
        setLoading(true);
        try {
          const res = await fetch(`${API_URL}/inscricoes-novatos`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              promocao_id: promocao.id,
              user_cod: user.codProfissional,
              user_name: user.fullName,
              valor_bonus: promocao.valor_bonus,
              regiao: promocao.regiao,
              cliente: promocao.cliente
            })
          });
          if (!res.ok) {
            const error = await res.json();
            throw new Error(error.error || 'Erro ao se inscrever');
          }
          showToast('✅ Inscrição realizada! Válida por 10 dias.', 'success');
          await loadMinhasInscricoesNovatos();
          await loadPromocoesNovatosAtivas();
        } catch (err) {
          showToast(err.message, 'error');
        } finally {
          setLoading(false);
        }
      };

      const handleAprovarInscricaoNovatos = async (id) => {
        setLoading(true);
        try {
          await fetch(`${API_URL}/inscricoes-novatos/${id}/aprovar`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ resolved_by: user.fullName })
          });
          showToast('✅ Inscrição aprovada!', 'success');
          await loadInscricoesNovatos();
        } catch (err) {
          showToast('Erro ao aprovar', 'error');
        } finally {
          setLoading(false);
        }
      };

      const handleRejeitarInscricaoNovatos = async (id) => {
        setLoading(true);
        try {
          await fetch(`${API_URL}/inscricoes-novatos/${id}/rejeitar`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
              motivo_rejeicao: formData.motivoRejeicaoNovatos,
              resolved_by: user.fullName 
            })
          });
          showToast('❌ Inscrição rejeitada', 'success');
          setFormData({ ...formData, modalRejeitarNovatoss: null, motivoRejeicaoNovatos: '' });
          await loadInscricoesNovatos();
        } catch (err) {
          showToast('Erro ao rejeitar', 'error');
        } finally {
          setLoading(false);
        }
      };

      const handleCreditarBonusNovatos = async (inscricao) => {
        setLoading(true);
        try {
          const res = await fetch(`${API_URL}/inscricoes-novatos/${inscricao.id}/credito`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
              credito_lancado: true,
              lancado_por: user.fullName 
            })
          });
          if (!res.ok) throw new Error('Erro ao creditar');
          showToast('✅ Crédito lançado!', 'success');
          await loadInscricoesNovatos();
        } catch (err) {
          showToast('Erro ao creditar', 'error');
        } finally {
          setLoading(false);
        }
      };

      const handleDebitarNovatos = async (inscricao, debitado) => {
        try {
          await fetch(`${API_URL}/inscricoes-novatos/${inscricao.id}/debito`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
              debito: debitado,
              debitado_por: user.fullName 
            })
          });
          showToast(debitado ? '✅ Marcado como debitado' : '↩️ Desmarcado', 'success');
          await loadInscricoesNovatos();
        } catch (err) {
          showToast('Erro ao atualizar débito', 'error');
        }
      };

      const handleExcluirPromocaoNovatos = async (id) => {
        if (!confirm('Tem certeza que deseja excluir esta promoção?')) return;
        setLoading(true);
        try {
          const res = await fetch(`${API_URL}/promocoes-novatos/${id}`, {
            method: 'DELETE'
          });
          if (!res.ok) {
            const error = await res.json();
            throw new Error(error.error || 'Erro ao excluir');
          }
          showToast('🗑️ Promoção excluída!', 'success');
          await loadPromocoesNovatos();
        } catch (err) {
          showToast(err.message, 'error');
        } finally {
          setLoading(false);
        }
      };

      // === FUNÇÕES DO QUIZ DE PROCEDIMENTOS ===
      const loadQuizConfig = async () => {
        try {
          const res = await fetch(`${API_URL}/quiz-procedimentos/config`);
          const data = await res.json();
          console.log('🎯 Quiz Config carregado:', data);
          setQuizConfig(data);
        } catch (err) {
          console.error('Erro ao carregar config quiz:', err);
        }
      };

      const loadQuizRespostas = async () => {
        try {
          const res = await fetch(`${API_URL}/quiz-procedimentos/respostas`);
          setQuizRespostas(await res.json());
        } catch (err) {
          console.error('Erro ao carregar respostas quiz:', err);
        }
      };

      const verificarQuizRespondido = async () => {
        try {
          const res = await fetch(`${API_URL}/quiz-procedimentos/verificar/${user.codProfissional}`);
          const data = await res.json();
          setQuizJaRespondeu(data.ja_respondeu);
          if (data.dados) {
            setQuizDadosUsuario(data.dados);
          }
        } catch (err) {
          console.error('Erro ao verificar quiz:', err);
        }
      };

      const handleSalvarQuizConfig = async () => {
        setLoading(true);
        try {
          const res = await fetch(`${API_URL}/quiz-procedimentos/config`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(quizConfig)
          });
          if (!res.ok) throw new Error('Erro ao salvar');
          showToast('✅ Configuração do Quiz salva!', 'success');
        } catch (err) {
          showToast(err.message, 'error');
        } finally {
          setLoading(false);
        }
      };

      const handleImagemQuiz = async (index, file) => {
        if (!file) return;
        
        // Converter para base64
        const reader = new FileReader();
        reader.onload = (e) => {
          const novasImagens = [...quizConfig.imagens];
          novasImagens[index] = e.target.result;
          setQuizConfig({ ...quizConfig, imagens: novasImagens });
        };
        reader.readAsDataURL(file);
      };

      const handleResponderQuiz = async () => {
        // Verificar se respondeu todas
        if (quizRespostasUsuario.some(r => r === null)) {
          showToast('Responda todas as perguntas!', 'error');
          return;
        }
        
        setLoading(true);
        try {
          const res = await fetch(`${API_URL}/quiz-procedimentos/responder`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              user_cod: user.codProfissional,
              user_name: user.fullName,
              respostas: quizRespostasUsuario
            })
          });
          
          if (!res.ok) {
            const error = await res.json();
            throw new Error(error.error || 'Erro ao enviar');
          }
          
          const resultado = await res.json();
          setQuizResultado(resultado);
          setQuizEtapa(3); // Vai para tela de resultado
          setQuizJaRespondeu(true);
          
          // Salvar dados para mostrar em "Minhas Inscrições"
          setQuizDadosUsuario({
            acertos: resultado.acertos,
            passou: resultado.passou,
            created_at: new Date().toISOString()
          });
          
          if (resultado.passou) {
            showToast(`🎉 Parabéns! Você ganhou R$ ${resultado.valor_gratuidade.toFixed(2).replace('.', ',')} de gratuidade!`, 'success');
            // Recarregar gratuidades do usuário
            loadUserGratuities();
          }
        } catch (err) {
          showToast(err.message, 'error');
        } finally {
          setLoading(false);
        }
      };

      const handleCriarPromocao = async () => {
        if (!formData.promoRegiao || !formData.promoValor) {
          showToast('Preencha todos os campos obrigatórios', 'error');
          return;
        }
        setLoading(true);
        try {
          const res = await fetch(`${API_URL}/promocoes`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              regiao: formData.promoRegiao,
              valor_bonus: parseFloat(formData.promoValor),
              detalhes: formData.promoDetalhes || null,
              created_by: user.fullName
            })
          });
          if (!res.ok) throw new Error('Erro ao criar promoção');
          showToast('✅ Promoção criada!', 'success');
          setFormData({ ...formData, promoRegiao: '', promoValor: '', promoDetalhes: '' });
          await loadPromocoes();
        } catch (err) { showToast(err.message, 'error'); }
        setLoading(false);
      };

      const handleEditarPromocao = async () => {
        if (!formData.promoRegiao || !formData.promoValor) {
          showToast('Preencha todos os campos obrigatórios', 'error');
          return;
        }
        setLoading(true);
        try {
          const res = await fetch(`${API_URL}/promocoes/${formData.editPromo.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              regiao: formData.promoRegiao,
              valor_bonus: parseFloat(formData.promoValor),
              detalhes: formData.promoDetalhes || null
            })
          });
          if (!res.ok) throw new Error('Erro ao editar promoção');
          showToast('✅ Promoção atualizada!', 'success');
          setFormData({ ...formData, editPromo: null, promoRegiao: '', promoValor: '', promoDetalhes: '' });
          await loadPromocoes();
        } catch (err) { showToast(err.message, 'error'); }
        setLoading(false);
      };

      const handleEnviarIndicacao = async (promocao) => {
        if (!formData.indicadoNome || !formData.indicadoContato) {
          showToast('Nome e contato são obrigatórios', 'error');
          return;
        }
        if (!validarTelefone(formData.indicadoContato)) {
          showToast('Número de telefone inválido. Use o formato (DD) 99999-9999', 'error');
          return;
        }
        setLoading(true);
        try {
          const res = await fetch(`${API_URL}/indicacoes`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              promocao_id: promocao.id,
              user_cod: user.codProfissional,
              user_name: user.fullName,
              indicado_nome: formData.indicadoNome,
              indicado_cpf: formData.indicadoCpf || null,
              indicado_contato: formData.indicadoContato,
              valor_bonus: promocao.valor_bonus,
              regiao: promocao.regiao
            })
          });
          if (!res.ok) throw new Error('Erro ao enviar indicação');
          showToast('✅ Indicação enviada! Válida por 30 dias.', 'success');
          setFormData({ ...formData, indicadoNome: '', indicadoCpf: '', indicadoContato: '', modalIndicacao: null });
          await loadMinhasIndicacoes();
        } catch (err) { showToast(err.message, 'error'); }
        setLoading(false);
      };

      const handleAprovarIndicacao = async (id) => {
        setLoading(true);
        try {
          const res = await fetch(`${API_URL}/indicacoes/${id}/aprovar`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ resolved_by: user.fullName })
          });
          if (!res.ok) throw new Error('Erro ao aprovar');
          showToast('✅ Indicação aprovada!', 'success');
          await loadIndicacoes();
        } catch (err) { showToast(err.message, 'error'); }
        setLoading(false);
      };

      const handleRejeitarIndicacao = async (id) => {
        if (!formData.motivoRejeicao) {
          showToast('Informe o motivo da rejeição', 'error');
          return;
        }
        setLoading(true);
        try {
          const res = await fetch(`${API_URL}/indicacoes/${id}/rejeitar`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ motivo_rejeicao: formData.motivoRejeicao, resolved_by: user.fullName })
          });
          if (!res.ok) throw new Error('Erro ao rejeitar');
          showToast('❌ Indicação rejeitada', 'success');
          setFormData({ ...formData, modalRejeitar: null, motivoRejeicao: '' });
          await loadIndicacoes();
        } catch (err) { showToast(err.message, 'error'); }
        setLoading(false);
      };

      // ========== FUNÇÕES DE AÇÃO ==========
      
      // Atualizar role do usuário (Admin Master)
      const handleUpdateUserRole = async (codProfissional, newRole) => {
        try {
          const res = await fetch(`${API_URL}/users/${codProfissional}/role`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ role: newRole })
          });
          if (!res.ok) throw new Error('Erro ao atualizar');
          showToast(`✅ Usuário atualizado para ${newRole}!`, 'success');
          loadUsers();
        } catch (err) { showToast('Erro ao atualizar role', 'error'); }
      };
      
      const handleLogin = async () => {
        setLoading(true);
        try {
          const res = await fetch(`${API_URL}/users/login`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ codProfissional: formData.cod, password: formData.password })
          });
          if (!res.ok) throw new Error('Credenciais inválidas');
          const data = await res.json();
          setUser({ ...data, codProfissional: data.cod_profissional, fullName: data.full_name });
          setFormData({});
        } catch (err) { showToast(err.message, 'error'); }
        setLoading(false);
      };

      const handleRegister = async () => {
        setLoading(true);
        try {
          const res = await fetch(`${API_URL}/users/register`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ codProfissional: formData.cod, password: formData.password, fullName: formData.name })
          });
          if (!res.ok) throw new Error('Erro no cadastro');
          showToast('Cadastro realizado!', 'success');
          setFormData({ view: 'login' });
        } catch (err) { showToast(err.message, 'error'); }
        setLoading(false);
      };

      const handleAcceptTerms = async () => {
        setLoading(true);
        try {
          await fetch(`${API_URL}/financial/accept-terms`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userCod: user.codProfissional })
          });
          setTermsAccepted(true);
          showToast('✅ Termos aceitos!', 'success');
        } catch (err) { showToast('Erro', 'error'); }
        setLoading(false);
      };

      const handleSaveFinancial = async () => {
        if (!formData.finName || !formData.finCpf || !formData.finPix) { 
          showToast('Preencha todos os campos', 'error'); 
          return; 
        }
        
        if (!formData.pixTipo) {
          showToast('❌ Selecione o tipo da chave PIX', 'error');
          return;
        }
        
        // Validar chave PIX
        const validacaoPix = validarChavePix(formData.finPix, formData.pixTipo);
        if (!validacaoPix.valido) {
          showToast(`❌ ${validacaoPix.mensagem}`, 'error');
          return;
        }
        
        setLoading(true);
        try {
          await fetch(`${API_URL}/financial/data`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
              userCod: user.codProfissional, 
              fullName: formData.finName, 
              cpf: formData.finCpf, 
              pixKey: formData.finPix,
              pixTipo: formData.pixTipo
            })
          });
          setFinancialData({ full_name: formData.finName, cpf: formData.finCpf, pix_key: formData.finPix, pix_tipo: formData.pixTipo });
          setEditandoDados(false); // Sair do modo edição
          loadFinancialLogs(); // Recarregar logs
          
          const tipoLabel = {cpf: 'CPF', cnpj: 'CNPJ', telefone: 'Telefone', email: 'Email', aleatoria: 'Chave Aleatória'}[formData.pixTipo];
          showToast(`✅ Dados salvos! (PIX: ${tipoLabel})`, 'success');
        } catch (err) { showToast('Erro ao salvar', 'error'); }
        setLoading(false);
      };

      const handleRequestWithdrawal = async () => {
        const amount = parseFloat(formData.withdrawAmount);
        if (!amount || amount <= 0) { showToast('Valor inválido', 'error'); return; }
        
        // ========== VALIDAÇÃO: Máximo 2 saques por hora, valores diferentes ==========
        const agora = new Date();
        const umaHoraAtras = new Date(agora.getTime() - 60 * 60 * 1000); // 1 hora atrás
        
        // Filtrar saques da última hora
        const saquesUltimaHora = withdrawals.filter(w => {
          const dataSaque = new Date(w.created_at);
          return dataSaque >= umaHoraAtras;
        });
        
        // Regra 1: Máximo 2 saques por hora
        if (saquesUltimaHora.length >= 2) {
          const proximoPermitido = new Date(new Date(saquesUltimaHora[0].created_at).getTime() + 60 * 60 * 1000);
          const minutosRestantes = Math.ceil((proximoPermitido - agora) / (60 * 1000));
          showToast(`⚠️ Limite atingido! Você já fez 2 saques na última hora. Aguarde ${minutosRestantes} minutos para solicitar novamente.`, 'error');
          return;
        }
        
        // Regra 2: Não pode repetir o mesmo valor na última hora
        const mesmoValorNaHora = saquesUltimaHora.find(w => parseFloat(w.requested_amount) === amount);
        if (mesmoValorNaHora) {
          showToast(`⚠️ Valor repetido! Você já solicitou um saque de R$ ${amount.toFixed(2)} na última hora. Escolha um valor diferente.`, 'error');
          return;
        }
        // ========== FIM DA VALIDAÇÃO ==========
        
        setLoading(true);
        try {
          await fetch(`${API_URL}/withdrawals`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userCod: user.codProfissional, userName: financialData.full_name, cpf: financialData.cpf, pixKey: financialData.pix_key, requestedAmount: amount })
          });
          showToast('✅ Saque solicitado!', 'success');
          setFormData({ ...formData, withdrawAmount: '' });
          loadUserWithdrawals(); loadUserGratuities();
        } catch (err) { showToast('Erro', 'error'); }
        setLoading(false);
      };

      const handleUpdateWithdrawalStatus = async (id, status, rejectReason = null) => {
        try {
          await fetch(`${API_URL}/withdrawals/${id}`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status, adminId: user.id, adminName: user.fullName || 'Admin Financeiro', rejectReason })
          });
          showToast('✅ Status atualizado!', 'success');
          setFormData({...formData, [`reject_${id}`]: '', [`showReject_${id}`]: false});
          loadAllWithdrawals();
        } catch (err) { showToast('Erro', 'error'); }
      };

      const handleStatusChange = (id, newStatus) => {
        if (newStatus === 'rejeitado') {
          setFormData({...formData, [`showReject_${id}`]: true, [`pendingStatus_${id}`]: newStatus});
        } else {
          handleUpdateWithdrawalStatus(id, newStatus);
        }
      };

      const handleDeleteWithdrawal = async (id) => {
        try {
          await fetch(`${API_URL}/withdrawals/${id}`, { method: 'DELETE' });
          showToast('🗑️ Solicitação excluída!', 'success');
          setFormData({...formData, deleteConfirm: null});
          loadAllWithdrawals();
        } catch (err) { showToast('Erro ao excluir', 'error'); }
      };

      const handleUpdateConciliacao = async (id, field, value) => {
        try {
          await fetch(`${API_URL}/withdrawals/${id}/conciliacao`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ [field]: value })
          });
          loadAllWithdrawals(); loadDashboard();
        } catch (err) { showToast('Erro', 'error'); }
      };

      const handleUpdateDebito = async (id, checked) => {
        try {
          await fetch(`${API_URL}/withdrawals/${id}/debito`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ debito: checked, debitoAt: checked ? new Date().toISOString() : null })
          });
          loadAllWithdrawals();
          showToast(checked ? '✅ Débito registrado!' : '❌ Débito removido', 'success');
        } catch (err) { showToast('Erro', 'error'); }
      };

      const handleAddGratuity = async () => {
        if (!formData.gratUserCod || !formData.gratQty || !formData.gratValue || !formData.gratUserName) { 
          showToast('Preencha todos os campos obrigatórios', 'error'); 
          return; 
        }
        setLoading(true);
        try {
          await fetch(`${API_URL}/gratuities`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
              userCod: formData.gratUserCod, 
              userName: formData.gratUserName,
              quantity: parseInt(formData.gratQty), 
              value: parseFloat(formData.gratValue), 
              reason: formData.gratReason || '',
              createdBy: user.fullName
            })
          });
          showToast('✅ Gratuidade cadastrada!', 'success');
          setFormData({ ...formData, gratUserCod: '', gratUserName: '', gratQty: '', gratValue: '', gratReason: '' });
          loadAllGratuities();
        } catch (err) { showToast('Erro', 'error'); }
        setLoading(false);
      };

      const handleDeleteGratuity = async (id) => {
        setLoading(true);
        try {
          await fetch(`${API_URL}/gratuities/${id}`, { method: 'DELETE' });
          showToast('🗑️ Gratuidade excluída!', 'success');
          loadAllGratuities();
        } catch (err) { showToast('Erro ao excluir', 'error'); }
        setLoading(false);
      };

      const handleAddRestriction = async () => {
        if (!formData.restUserCod || !formData.restReason || !formData.restUserName) { showToast('Preencha todos os campos', 'error'); return; }
        setLoading(true);
        try {
          await fetch(`${API_URL}/restricted`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
              userCod: formData.restUserCod, 
              userName: formData.restUserName, 
              reason: formData.restReason,
              createdBy: user.fullName
            })
          });
          showToast('✅ Restrição cadastrada!', 'success');
          setFormData({ ...formData, restUserCod: '', restUserName: '', restReason: '' });
          loadRestricted();
        } catch (err) { showToast('Erro', 'error'); }
        setLoading(false);
      };

      const handleRemoveRestriction = async (id) => {
        try {
          await fetch(`${API_URL}/restricted/${id}/remove`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ removedReason: 'Suspensa pelo admin' })
          });
          showToast('✅ Restrição removida!', 'success');
          loadRestricted();
        } catch (err) { showToast('Erro', 'error'); }
      };

      // Submissões OS
      const motivosComFoto = ['Ajuste de Retorno', 'Ajuste de Pedágio (Campinas e Recife)'];
      
      const compressImage = (file, maxWidth = 800, quality = 0.6) => {
        return new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
              const canvas = document.createElement('canvas');
              let w = img.width, h = img.height;
              if (w > maxWidth) { h = (h * maxWidth) / w; w = maxWidth; }
              canvas.width = w; canvas.height = h;
              canvas.getContext('2d').drawImage(img, 0, 0, w, h);
              resolve(canvas.toDataURL('image/jpeg', quality));
            };
            img.onerror = reject;
            img.src = e.target.result;
          };
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });
      };

      const handleSubmitOS = async () => {
        setLoading(true);
        try {
          const imgs = formData.imagens?.length > 0 ? formData.imagens.join('|||') : null;
          await fetch(`${API_URL}/submissions`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ordemServico: formData.os, motivo: formData.motivo, userId: user.id, userCod: user.codProfissional, userName: user.fullName, imagemComprovante: imgs, coordenadas: formData.coordenadas || null })
          });
          showToast('✅ OS enviada!', 'success');
          setFormData({});
          loadSubmissions();
        } catch (err) { showToast('Erro', 'error'); }
        setLoading(false);
      };

      const handleValidate = async (id, approved) => {
        try {
          setSubmissions(prev => prev.map(s => s.id === id ? {...s, status: approved ? 'aprovada' : 'rejeitada', validated_by_name: user.fullName} : s));
          await fetch(`${API_URL}/submissions/${id}`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: approved ? 'aprovada' : 'rejeitada', observacao: formData[`obs_${id}`] || '', validatedBy: user.id, validatedByName: user.fullName || 'Admin' })
          });
          showToast(approved ? '✅ Aprovada!' : '❌ Rejeitada!', approved ? 'success' : 'error');
          const { pendingFilter, adminTab } = formData;
          setFormData({ pendingFilter, adminTab });
          loadSubmissions();
        } catch (err) { showToast('Erro', 'error'); loadSubmissions(); }
      };

      // Helpers
      const calcWithdraw = (amount) => {
        const gratAtiva = userGratuities.find(g => g.status === 'ativa' && g.remaining > 0);
        const hasGrat = !!gratAtiva;
        const maxGratValue = gratAtiva ? parseFloat(gratAtiva.value) : 0;
        const fee = hasGrat ? 0 : amount * 0.045;
        return { fee, final: amount - fee, hasGrat, maxGratValue, gratAtiva };
      };

      const formatCPF = (v) => {
        const n = v.replace(/\D/g, '').slice(0, 11);
        if (n.length <= 3) return n;
        if (n.length <= 6) return `${n.slice(0,3)}.${n.slice(3)}`;
        if (n.length <= 9) return `${n.slice(0,3)}.${n.slice(3,6)}.${n.slice(6)}`;
        return `${n.slice(0,3)}.${n.slice(3,6)}.${n.slice(6,9)}-${n.slice(9)}`;
      };

      const formatTelefone = (v) => {
        const n = v.replace(/\D/g, '').slice(0, 11);
        if (n.length <= 2) return n.length > 0 ? `(${n}` : '';
        if (n.length <= 7) return `(${n.slice(0,2)}) ${n.slice(2)}`;
        return `(${n.slice(0,2)}) ${n.slice(2,7)}-${n.slice(7)}`;
      };

      const validarTelefone = (tel) => {
        const regex = /^\(\d{2}\) \d{5}-\d{4}$/;
        return regex.test(tel);
      };

      const formatMoney = (v) => parseFloat(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

      // Máscara para CNPJ: XX.XXX.XXX/XXXX-XX
      const formatCNPJ = (v) => {
        const nums = v.replace(/\D/g, '').slice(0, 14);
        if (nums.length <= 2) return nums;
        if (nums.length <= 5) return `${nums.slice(0,2)}.${nums.slice(2)}`;
        if (nums.length <= 8) return `${nums.slice(0,2)}.${nums.slice(2,5)}.${nums.slice(5)}`;
        if (nums.length <= 12) return `${nums.slice(0,2)}.${nums.slice(2,5)}.${nums.slice(5,8)}/${nums.slice(8)}`;
        return `${nums.slice(0,2)}.${nums.slice(2,5)}.${nums.slice(5,8)}/${nums.slice(8,12)}-${nums.slice(12)}`;
      };

      // Validar chave PIX por tipo selecionado
      const validarChavePix = (chave, tipo) => {
        if (!chave || chave.trim() === '') {
          return { valido: false, mensagem: '' };
        }
        
        const chaveLimpa = chave.trim();
        
        switch(tipo) {
          case 'cpf':
            const cpfLimpo = chaveLimpa.replace(/\D/g, '');
            if (cpfLimpo.length === 11) {
              return { valido: true, mensagem: '✅ CPF válido' };
            }
            return { valido: false, mensagem: '❌ CPF deve ter 11 dígitos' };
            
          case 'cnpj':
            const cnpjLimpo = chaveLimpa.replace(/\D/g, '');
            if (cnpjLimpo.length === 14) {
              return { valido: true, mensagem: '✅ CNPJ válido' };
            }
            return { valido: false, mensagem: '❌ CNPJ deve ter 14 dígitos' };
            
          case 'telefone':
            const telLimpo = chaveLimpa.replace(/\D/g, '');
            if (telLimpo.length === 10 || telLimpo.length === 11) {
              return { valido: true, mensagem: '✅ Telefone válido' };
            }
            return { valido: false, mensagem: '❌ Telefone deve ter 10 ou 11 dígitos' };
            
          case 'email':
            if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(chaveLimpa)) {
              return { valido: true, mensagem: '✅ Email válido' };
            }
            return { valido: false, mensagem: '❌ Formato de email inválido' };
            
          case 'aleatoria':
            // UUID com ou sem hífens
            if (/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(chaveLimpa) ||
                /^[a-f0-9]{32}$/i.test(chaveLimpa)) {
              return { valido: true, mensagem: '✅ Chave aleatória válida' };
            }
            return { valido: false, mensagem: '❌ Formato de chave aleatória inválido' };
            
          default:
            return { valido: false, mensagem: 'Selecione o tipo da chave' };
        }
      };

      // Aplicar máscara baseado no tipo de PIX
      const formatarChavePix = (valor, tipo) => {
        switch(tipo) {
          case 'cpf': return formatCPF(valor);
          case 'cnpj': return formatCNPJ(valor);
          case 'telefone': return formatTelefone(valor);
          default: return valor;
        }
      };

      // Placeholder baseado no tipo
      const getPixPlaceholder = (tipo) => {
        switch(tipo) {
          case 'cpf': return '000.000.000-00';
          case 'cnpj': return '00.000.000/0000-00';
          case 'telefone': return '(00) 00000-0000';
          case 'email': return 'seu@email.com';
          case 'aleatoria': return 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx';
          default: return 'Selecione o tipo acima';
        }
      };

      const statusLabels = {
        'aguardando_aprovacao': '⏳ Aguardando',
        'aprovado': '✅ Aprovado',
        'aprovado_gratuidade': '✅ Aprov. c/ Gratuidade',
        'rejeitado': '❌ Rejeitado',
        'inativo': '⚠️ Inativo'
      };

      // ========== TELA DE LOGIN ==========
      if (!user) {
        return (
          <div className="min-h-screen bg-gradient-to-br from-purple-100 to-purple-200 flex items-center justify-center p-4">
            {toast && <Toast {...toast} />}
            <div className="bg-white rounded-2xl shadow-2xl p-8 w-full max-w-md">
              <div className="text-center mb-8">
                <img 
                  src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAHAAAABwCAIAAABJgmMcAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGYktHRAD/AP8A/6C9p5MAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAAHdElNRQfpDAEAESjmv+FkAAADWXpUWHRSYXcgcHJvZmlsZSB0eXBlIHhtcAAASImdVkGSozAMvPsV+wRbsiXzHGLgtlV73Odvt4EAM2RmM0lBApKlltSSHf7+/hN+4ZNUctCmi1ePlkztYcWzRBMr5jbYrJP4vDwej0Uc7wfLfFNcS5405sljVuhWG0KuPjoWFvUxzyUbfmFQFYvEddE5jtq86ujVsNAmOrMkkc/WbHalLNAD0GRbiEPHVfBUB5LNlEDHdCySc7YPZiALENJU9Yxv1BFLF+8fmR1aMtsCRZdFkw784l9UwV1wn1YHMgVXRy7o3atM9AB5RxFHiQcSwEBqELjY4BH6A2KYgWyTB4Ql8IlAiEycy6/Ac+poYcDkM/ruerYUDiUa2/zMqOBiE9SQPSgiLJk17hmjK20XB2PIXXUXn4MpKKynQ3KWAe1whEXyBESDBSU7IkfVyBLp2WC4AmTlQLGbu2LJzFtBjhBQAdFmZBnV0CIT6pNwVzw3We6WHat2F+HWRwHXcx66+QhyVoNpFEW7m4JnUdRYc5dE/AMhK8T8K8rqwheQDFAueMMFnzGd3Bwhhxs84NeGhsZ4wQGMJyBIcEc39WPY4br0q6SiD1EApL8+S8O8bubC14rn0styLv6ZMJSEO87c5OXEtrPJo3HCuXPe77CjwcKrDoOi3syF2GnajplAPdxByAZiYfpwAjy7Kl27qhsdiQdXO+fuwM5ea56/7KiOsz8lm82Js48cctvA8UILgZ5LBFDltGb7wQwGaW6c2ZziRvIhL1yI9z1flmDZcaEnJRZpGsbkfajvi50e+vNZNfeM4ElgfLB1uVnp2Gm+hRUBxCNNyYTQ0nec2Sp6SUqg6D6Z93x5RZfwLl9e0SV47KovZ/G+UR3jd12xEUV3omzzaDPHQc/JXUk3VFPxFJlSNyDV/rbtpq7a4Sf5uNMLP8nHunlf0xG+yQdGqcf77Wgzdxn+CIvTCN+mM84X4BWyQl5V7ilgWe7kwyVD5/jClsYpIAEQBlApHCPC9lA2CGOGsk7YnxLIVfOcW0Fpyoi5TxOy0RdhZ3nqKA8RtfAshNNP32B4cGnrZgNzb/RgeNWE7/ZgeNWE5x7s5Lik9nNmw/+z6Ky1Hreebytb5HKgW0U3p8qyJhgjTdYDYfgHTFxxn8a82H0AACIpSURBVHja7X1plF3XVebe+5w7vFev5klVkqpKs6x5suMROwk2EDokcZpuaBxI3OkmDQESAiTQCenVsFhMccMCegVoNziEQCYnjr2ixKFtx/IkS5ZkyZpdUqkmlUo1V73p3nP27h/n3lcly5LLTpSYxbvrSSpV3fvuvt/Z47f3eYU/HXwcqsf376AqBFVAq4BWAa0eVUCrgFYBrR5VQKuAVgGtHlVAq4BWAa0CWj2qgFYBrQJaPaqAVgGtAlo9qoBWAa0CWj2qgFYBrQJaBfTfwiFvekDF/RGRH4Cw8zcVAAERWfz5AgAieM3FpO/puQBABBAAEQThB4SpoCAAAiIsElJBQABAEIRrjOkbBFRABFBEkBCARABR5Bpj6t5aBIHc/RARr6am4tRSkADAnQ/iMH1TASpuxUVIkbUS2TIDM0Mibqo28sqXpKZ35UVyJyUm/YrVcW8tRMAWynFZ0DALIqbuRl65nIgiQgqt4chGDIaZK0K+iiSV+87/VObFlkVpC70BON2NlCJTNuCZ337wnl954O44jgABUUASU0QRFEGovAAFAS/XqMTBoSCiJC8QFAFMHaUkBkGKbMwGSh/7x5/5+IPvY4nBXSUgsMDtJNeIVjouWczApx5+/y/f/544jjEV8hI9FRAQQScwACAQOFeGgAjuBxUXLN8/QAUABQRJU6lk/Cb63Yfvfcs7tze05ghRKU1Ko3IwChCSp0jNv4BA5HLPh855oEJSmpR2J6MiSUBO1khpFZUNZPkTD/7Cj/zHG+rbahWRVsrdFMU9sMNWRFBrKhbjTJv/6Uc+sPPHN9e15hBAKY+UQjWvpwIAKABISKQVEgqLjdlE1sbWGYFSikgtxgHr16eaKCCoteQLUXN37e987f1rtq8AgDOHh8dluq5krWUPVegHAGgsF0sFAMBUCTIq4yniFCRwT+QQQMiXCiycLhpqpIwXSBpGlFbFQqm2LfjtB9+/8ZZ1ANB3ZPhiNFWraqy1Gr3A91AweVdB5al8vti8ou5TD927cnMXAJw5ODgB06bEbNlDL/B890QoAIQKqVSKIikrUJlskKsNlNLWcJQvF/KFGFiDDoOQFLJlxCuihIsaCZcksoIgeZTPFzs3NH3q6x9ctqbDxFZ76uL58YPfOgagggw9/42jz/zTcVLU2lP3zo/dhFq7S63wI3/27OiJcR1qYBchKr4O4pL50Q/v3HTLysJc2RoOa4IXHz255/MveaEWBq1prlBo6an/3Yc+uGLL8jiKPN+fvji199tHIYYwq1/8zsuP3X/ACz0QEQHl6bl8vntL+ye/dm/HynYbW+Wp0aHRQ4+eRFR+Rj3z4It7v3QiCANmIYUmNkVTXr625S3v3rT5trUdaxtrGmq01jbmwkzx4sDE6f0DB3YfPf50v40xDDyn3fhquOpFogmAIqA9ms4X1t3Y+d+/+v6WzjZrrPaUiLQsabrrA7dZw0qT54dP/dOR2ML179n4k//t7dZYUiQspOjYd/sGT1zwyWNO3AcIAIGNuaYl+JlPvqOpvV5YWEQpau5oePzzh31A5eFcvrB8c+unvn5vx8oOa6zneyJQ11J/1z23WMtKUUNrw7/cf8D5ReXRXD6//pZlv/PVDzS1N1tjladEpLWz9a4PtFljlVaI6qkvvRRioBXki+Xmztx/+fS77rhnZ5jNiAhixa6gob2uY3Xblreuf+9v3XnsmdNf+J3dJ/YMKl+B4Bs0eXGGBEJKTefntt+15hNffH9tQ84aVlq52wuDtZYNK02nn++3gAS45vouALDGOosul8r9L573QAsn4cktFSFFNl61rqOhPWtig4jWsFJ0al+/Aas8PTU7vfHWrt/+8r1NSxqNMVprEXH5kjVsjVWKTu3ri8GEFCDgTH7uhp9Y/5v//PM1dTm2lwspSsOpvQMCoDTNzhbX39r1W//8vpalzcxijWXLiJW8VZKwBAAgG29e+/N/7H3i5r9S8j34UBc4SeFssXDT3Zt+4x9+LpOtYctKu1CCbNkVSkgEAGcODiBQptZfsbUTALSvAZAIL/SOXOybdhq9MMYhggXp2dZJ4DFapciZUu/BAQ1qZja/467Vn/jSB3L1tWytStB0N50XsvfAMAERwdxc/rb/sPnXH7gnCDNsmdTlQiIA9B0a9EEX5qLure2ffOg/1zXVmtgqTUiotBbn5ZNYiSLCVpzOPvKXT1hrfN8T5ooWv16TR9JYKJRv/9ktv/WFe2NjmJlUJZlnJCQkYUHC/HRh+OQYArcub1iyohkAEFEsA6lzh0fyhWIuk2VOhKsYDYKsuaF7weJRqVQaOnrRAN/8U+s+9dCHrGVrI6U8EXBPiISEKCJKe1G53Hd4OECvMFd8689v//UH3m/iOBXSZWqXCDkzPjd8fIyUJ2j/65+/u4ImAAjz3m++dGzPmfJs2Qt1U1fj2l3da3d1a98jwse/sPexfziUC7PCaVB9/YA6TycaYGJo7quf2X3rv9/Z3t0mLIAgDEhmz1cODx656PlKBfrc0eHp4TwDLt/Y7Pk+W0ZCAQSA3gP97AKQq1Yr0d9I6Hkrty1N0BdAhJEzY6N9UwHo6QuFL//Joze+a/PytZ3MiaUjwrMPHzyzbzgIA/JoqPfCxd5pHZIpqrHB2a995ts3//S29q72REgRJH7yiy8MHZvQvvICffbw0PRYydh410+s2Xz7OraiNAkDKfi/H//6F+97zEMtaTobou5Y2/oTv3xj16bWv/+NRwIKXIaL+MZ8qCCgsEU/CE4+c+65J19ataOrvbvNrTwSTl7M/+WHvjI5PqdRibACL5cNOS47B+qgI0IA6H1hUAFJiiZAYn9R2bSvbOhY1QIASMhWgLDv8HC+UKrL1pw5eP75vcc7VjcvX9spzKgIEUuF0md/5WvD5ybck2vAjB+wlTBQx77bt/exI6uv72rvaq8IOTYy85cfenBqKq9RsYgGVZutKcZz299xXVKbCpLCuYmZb33uuVqoydZmGFhERISNDJ+8+Ne/+nWNpLSnPXKZ6Rv1oZikNQKiQa/oXNK1oSNVJUHAoeMX44m4OVcvnJZQLBqwZ8dyd6GDbXZyZvj4qEdaRGQhV0EUg126sSVTk2Hrim4BgN79QwIiCBp0V+OSVduWAQgSCQsqHDx1cW6k3FLTUKllrWXnLjSqnq6Oro2XCDl49EI0ZVtq69kmQjJbD4LuTR2JkAjCUtOUfdeHb3v4T56emJlmYA+0R54OVDYXsoBYERC5KpqLTOwRBFBhqRytXt3Z1F4vzIAoDE7vymJ8FjZWEBDRxtzQmuva2HbJI528ODlU0IHnyoMF1TkK8JpdyxNNASQiAD67f0iBRoAoijuva2nramawiNoyE0DfoaFiuayVEsuSMl0AgERROV6yenl9c13FKQHAy/sHylAOrc82DS5ApCCoVZdUa4z3fPpdP/bBW196vPfk3r7+IxfOnxwbH5kxwBkdeJ5i69CUVw1Hry8PJSQDcdfWDgDFbEhpRHGyQlKbJLlubM2SNR0tS+pEGJCEGQDOHhoqSVxHgbWMFYEQRIQAVu5ansAsgIST4zODpy746ANIBLZna7tSnjVMKtHfU/v6HAYMiCIAmAQ5RAN25Y4OAGK2pMgp08svDJAT0hkbIBHE1o72Tq/bCcJCCbDELC1Lm+74uaa3/twNgmZ6bK73xfOHv33ysc/tn7lQCMOQ2V4dU3pNNF2dCwIAtOb65ZVUihRZE587ckGDEpaU3QADZsX2ZQBeal8IAKf3DSZ160InCmBjrmuo6d60BACAEi5u+Pjo5Pm89hEEBXjlrqUV4kcpFIj7Dg1pUCKCLsVFZ/kIAgi4aueyyn1JURzF/UdGffBSp5SwMQT42APPAwAqMLF10rp0lS0bY5ixoaV+x1vXf+CP333f/o+uurGzWCq5zEGurKH0mubu/jLMWS9cta3imwAARvrGR86O+dq/lO2gNbuWVRZEaWLgvhcHNWhHQmFKhCGBMaZ1ZWPTsgYGrpCbZw8OR2BRg2UJUK/a2eVuCgKIauL8zPlT477SlXw2LYyFjanJhCu2LnXxzZ0wcmZ87Nyk5+mkq+A4JSuZMHvgm6f/5mNfjk2kPeXyU7aJl1RaESphEBYT29ZlzR/73H+qbQlsZJEQr0xELoJtEgQELpuWnlzH6o5EVmZHTxTmyspLTQCBjWQ8vWLH0kpEAoDRgfGLZ6Z8rYUdwYauaUJIEZhV1y/1yBczz4ud3HfOkWYmMk1LajvXtlbcMQD0HxuZHisoT1XcMbpiDjGOpbW7fsnK9lTXBAB6XzxXKJZJq0Q1nMGBCHMY+A/f99RHttz3z7/3zbOHzxljlCZSSIpAhK1FQlSoPWUis3RN503v3Vq0ZUWOhnyjpSegEFEMZvmGjjATsGWihErs3T9oHQ/pUnLEuMzNK3IdK5tdiBAWBJy9mC/ORkrptJpLKk9gUgC3/+zORAFBSGEcl84dPu8DAYhh03Fda2PLJWHwzIEBA4yEbg1SgAAJY4i7N3cEgc+WiSgVcohTITEpzUSc20WoydSMnJ783O/u/vLvP75sXcuqtyxbc/3y5ZvaV25dnq3JiqT1EiEAdG1oF3AFEl/Jhy4isRcAQAt21fWdiScDICIA6X1hIPVlLrtCBtOyvCGbq3Ha5GJCbVPWyyiOnBkCApBCABorTNz94R/Zcvs6ZnE/IqLz/ZOjZyY97QmgAbtqx1IAcJyQe7fT+4cUKHCkZ6KeDlXk1OG65IyIAMyZg0MKdOpwXfREQCAEG1vyMQj9AHw2fO7I6OkjQ9/6P3t91EvXNN/7F+/cedcWtknFBQAmjqXSsLhCXFqEybsKD9SqnZ0Vr0qE5ciMnJn0QCOhYxAQwALXNtUCJOYGiNaYJT0tN7xn01h5ykTGRtaUzFyhOFfIv+eXbvvgZ94tktCL7pJzR8/PzRaUR07tKxHJ6SAAjPROEmhERCRygc4JacUDtXJHZ6rvQISlYnzh7JQHmggQKTF2EEKMjPXr/blioVSIhEV5lKkJ6nO19bnabE3m3Kmxz/7qV+OoSGo+CA2fGndUvlw5yi+KYLaxrWvIdG9cCgAuE2HLge9tftuKh08/ZYsZYNGayA8AgI1dGM5QKQD8xb94T12Lv//h06W5OMj5K7a03/mLb9l55yZHOizstb28f4gBgJAjWxNmVmxe5ryHQxwVbrmj++QL56RokVkpX2tyJmliW9uSq6T0Tq/DTGbT7ct3n3neFANiIK21UqRwujD39vft+NCfv/c7f//co599dujUuAFQoJXDi7gI5TU7uj0/49pQpKlUKp18+twl2cKrqt/VCWYBIIRyySxb3/yZgx8NQr/SaxTkuBSdeOZsaS7KNYf3f+SRs/svCEDPttY/3f8xrUgSHUURYWalVKlcLs2Ww5ogzAQiYq1VSlXQFAEi/B/v+N8v7D5VU5OJ83Hj8ro/P/KbNfUZl6W7d4ui6NRzZ2cnSvXtmQc+vvvEnnNhJgCRcinu3tz2pwc+6mm/whIBcrkYHX/2TLlgco3h33z4ocEXL1rhrh1Nf/T4R7J1NQBQLBSO7jl9+Dun+4+MTl8osrXZpnDTHT0/9ZE7ahvrRISNVZ5++msH/vDuB7KZ7JV4pkVp6Px1akFYcz5dyA/CrW/b4Hjl7g0vnNw/UJvJDp242H/s/MrNy5itUo6LRCSylgPfD1sCEIjLhjQ6ZrPS8yLC/Mzc0LExja5ChTSFZlceIoKIeNrb9CPr3E1Xbj58ZE9vBkNJfQIDiHCSOCOAUBCG29+20Z3ftb719KHBto66j/7d+7J1NcYYBAwzmV0/tnXnXVsQkZlFRCmVuCABa432aG567gufflSBN+9C32AeCiICnqfGzk2NnZsCIGt4YePPGjZxDABxZABAaSqWom/+1R4AYGvZclpTAhG6nI6ZvUBf6BsbOHkeEa0RYbGGAWD41MWJwRnP12JB+3pyeGb45VEAsrEB4MQtIFhjTWzd3ZMeEoPW6kLf1ET/FKITMs0UxQlpAIAFYjBd17Wv3LJcBMgZeMorV/pxnMppLWvtlYvRfb/w+b4jF8KMx/YqSf2iAHWcI83Nlb/8B7sdZJdcr1D7HgAIWgCwVrJh5jt/s2/33+7xfD8J82kij4TaU3EcffOzT/zals989pe/6NQKE04Zel8cKdqYFAEIKiyb+Et/8CiD0Z63wG8hKdIeuZg3TzD6ana6+JU//BYAKEULgyop9HwNAFGZMxAc2zPwe+/823PHB0gjKURCUoREwMJWrGEEUB4RkdJ05lDfJ9/+F88/dKI2k7FW8LVmOdRGfetV1TMxNN/Tp18Y7D080NpTX99co/3EV0TFeHRg/Kmv7H/igQNcACQAAUV67yMvTY5Mt61qqG3KKSIktMYMnr7w+AN7//qXHnz07/ZJTETYvbU1P12aGJ6ZvDAzPT79yJ/tudA75WkCRhHxPe/skfMnn+tt6amrb8lpz0vcaDm+2D/x7DcO/b/798XTggpcTevr4MTz/eeO9bf21NU312pPzQvZP/7kl/bu+ceDtghaq75j5594YF/f4UFGk6kNwtpAKQWYri5BYar40jOnvvg/v3X/x74xenamJpO11ia9pqtq6Gt2PZOJBSKLoPKlImlY0t1U35olrcolLk6WJs9PzxZKGR2qNF9z+U2+VMpmMktW19e35ZBhcnTm4tnp2UIxQB2EoYgYY6xlhZSOcgkQeq7JkTbribBQKoHCjuWNDe1ZCtAUOT8VTwxPz+ULgQ504qaTmpJQFUpFraGtu7G+LUMelQtSnChNnJ+dKxYzXqiIRIS04pgLcRFB6urrWroyjUvqw8acH3pRPpoZnRk9M3lxeMqKZP1M2jrGq7FMiwA0UU9rhdAW4zD0OPTYWCiX2YIVEAJQQMrTyiPXtMGKjSOQIo5tFMcWAIAVKM/ztQfMwq69g5cOJ7nqiRdSZCICSilhjiLD6YyfAqU9Up5i5ksISgFBUaSYIS7HFjgVUilPXSKkiHMFIGTi2Bo2YBgAgBGQADV6XuAhiQsDSY2XDEi9MfpOgIjzJf/OHYfuvvHAN57b/OTxDROFuqwfhVkU0K4+ckMibK1LJ9PqXxDQWouEQeg7OgQERNjYpO50GnhZUVaRtVJ8gWWLAH6gIe3uikBy01ewvcl9GVH8UAGq9HwBgYVCuuusZQQmRUqrAL0FjRk3AmSAAQFZkIWsJa0sESdp/hVgvZoPRURmagiLP7r98C2bTmzr6ffRDE3WTRWyKKhIQBgSVUtplETRkpmQdFWTghUlmRNKEH0V6vvy7yXMh7hWhQCwpHN1lyuL42TdMqcTSwLpWMGC0YrK2W40ihgEgEUYjFHlWJdiVTZeZJQR1mRqM/kljROx0cZ4SAvoiNflQ0WASPIlb03n8K/91O6e9pGygeHx9j2HNzx5fO35yTaNEPgRIYsjkOa1BBaUuqnaCQC+pgu6CqWQxlfEVEcWcVUqCsjlN0/Sf8tUin0AUGhDr5wLS/XZmcb6Ynv9VFv9dFv9dHNtvjZTXNI09dVnbnrgsbfWhiXrBtpeL6AOU0VcKAdNdRMffse/7Fh5qmQo8HhyLvv8qQ1PvrTu9PmOUpwJVOxpwRTZRH6Redf4pjuSATzLqjYzd9PaU22Nk6310y210/W1+VxQDD2jVIKAYTCxyvjyv77x7544srUmLFmhKznSq6dNgCgsFHgmX6556sSqwJPrlo4WjdUq3rB8+JaNJzf3DOSCwkwxM5XPRrHvSDvChClzo4Dz7ExFTypfLyZwXq52lxZzb+w9EBBJipG3fcXAR37moTUdQ51N4425uUBFAhxbKMcQGYwMGoue5uHx9geeuN11cB0d8wby0AQAFtDEBPq50ytGp+q29IzkgvJ0wUcwHY2Tu9acufW6Y2uXD9X4pUJZzRQyhdhjqwhJocWE03XkLlQIN8c/p773NXxB0t+oTMth2plLWM2U334d2CZ39LQ9P1k3NlG3eslYoEqlSElKXBMCEhCCCGQD2H1g+76X12S8mAGvYnSvpaGVQVhBRAk9OTHcceDl7mXNUys6xmNDZQORAc8zPW3j16/vvXnjqS0rzrXVTyNKsUxzpUzZBMYql5sSCc2P1EIFZbyK/1sQQ9zJBIAIlL5YaJ40XqyPdoFO0pVURwc6j57tXNo23dYwwyn7nFoVEEEpDj732B35Uo0iWSjR6wY0dYGV0ImhZ6bydXuOrS3G3sZlI5kwjo0SAGMojsnzy0tbJretPnfLpqM3bzx13Yr+zsaxjB8xSznyimUXOj1jiQUACIWSGWEEckmAexEQJrshKvmYCDLr2HomVmWjSkYbA54uIRlmTXSVeY5L16nCSIMAgiLOetw31b7v9NK3bzoV+iWRFEwEEcoGcqB39e59u0KPGdJLX3ceepmjctHVMgVeLKK++tStR3p77nnbnu0r+opGjEFFzALFMjAAkm1pmOxonrht44nIqplSzfh0w4WJuqHxxgsTufHpxqnZzGwpG5WDyHjWIgMygABVaCL3UAiAwAqElPjaZDPFbE2+vq7QUj/T3jzZ2Ty7vH1sei533+d/Mo5DIn4VKkgWQOmaeQgoSMhIYFgVylqR3d51+sd3HqoJirF12VjSE2MAFr3n2FojvmARhORK7aTXA2jSA0YUQGAmRMmFce+FZb//xffeuf3F9970bGvDbL6kmVkREwIgxAbKhtwEfCacWZmbWdMNiMACxmKpHOSjIF/yC8VMvpwtlrxiOYiMYpHYakDWJEpJ4MVhYMJMVBMWwmypJlvKBVHWj5QSQgALQDA40pK0tS6zRYFKtpH865yjAJSNjizWZWZv2TB4x5ZjW7v6fa9YjDH0AQ1FlkBYgAOP+0fbX+xdlfGidIryannL4kfCE9N3OxME0LKEXgyiHtl34/7TK9970/7bth3NecViBCxEyIii3AIAsIUyI8fONTGReH6pKSw1N4AiIALBJAhYTJ/ZFQcE1n3BYASYARkiBolRGIShNiu9A0tmC7lsGFe2g2BlPiXtOyEyEohgZHRklU9Rd9voDWtfvvG6kz0tY4hmpuSLoVDR3//LLbHx7r3zu3FMDOxr2HNi3UyprjYsMrvRg+9xcuQVQSpdbUFkAUCuDYuTc41/tfvOx15af/fNz+9ceyZQtlTWDIzIyWqSAIoCFGA3S8QMLMgWBNOAj0mBg4iIwABC6cCr28YzzwMCKiAEi0IE/SMtDIgozJQ4SLePBIFAANAIxFFoBDwqtTdf3Npzbtf6M+uWDtaHpbKBuYiEg1ymPDHddN/utz97el2gordtObGy7XyZaXouu/fYWl8ZN3mG8BoVxesEdEHW4eZAUNAKeMr6Gk8Pdf/Rl5duXdn3zpte2LZiAJQpRciCQgucDi4omlASZSQAEALgdIdcEgbR5RjJthFKtyRJ2hVGhNhi/3Cby8GJuMLNWKsiizETgtQE5e6l/eu7+7etHFjVeb6uJo8MxQhniq51zbls+YXe1X+9+0eHJ1oas6WpQubpY+tWLxkMiZ44uWpovC0bRPaK5fv3BVAHTeKfUUQYIPRjADnYu/rImZ4tq/p+/PoDW1f31Xhx0WAk6NIdvILWL5RVAASRk6CPleAtIojkBsDcuVrB9GzN0GizVhIbbYy2ggJCaHOZwtLWyZ6O0bVdo2uXjixpGgvCSCzEEeSLmE4UQuhzxOEXHn/LV569nsXPhVFsKVRm76nVd9+8tzGb/+7hjZDsUFpUTvY9AAqVFDJtiQkAUjaIQOjg6bUHeldsWD70tu2Hd113pqFuNrIQxSSslLKvWf4sZj+mCCiCfMmfyWukqD6Xb8jNtTdPLmub6mobWdY23VI3kwlKiGAMRDHMFYgACJgIxAIi1Gbh9FDn/d+543DfipzPSLGbr9eeGZ5seurEuvbaueMDS0PfiCyODV3stprF5MouGiToAiGLUCnSLNTZcv7Gjadu3nimq3PE1zYyEltgQKLUoikpeJzJAyKjSLpZoMKZVlYNBEgA3UioBP3DrQS2ub5Yk5kLPOOivzFgLBiLIArRAAAwIAAwiqVsxpbL4SN7t3/96RuLpWw2jKxQZfNQMlwPDICcTEkttmjAa/CrK+YLdbescazLlnJ+cV334A0bX966+syS5klSEFsoWQJkomTSMJnyQxCqzHw6TN0kLlc2jRIAMggAMQUaRNgwsAVmECESoaQLAAAEwCAgTMIQaPYVHurt+cJjtxwf6KnxjCKbzn2mG14SYrCSEuNi9fPaADq/g1FS8pOQLatyrFmgMTe7rnto29qz160c7GyZFowiZnK5AAAjMAJhsiuUcT5Vd+9KAm5sUUQcssIV5hCSgX5OR0QEEIiFLaOvVM4350Zav/bUridf3GzZywQRuz2lDr8Ft7oU09fBEuC1/eUqlUnDxJQFAY3FKFYMUJ/Jd7SP3/OO767rGSjHgAQEIKmSunBvcSGxCiiQTI2n/CvC/NfC6XidVABFZtKKM55MzNR9+/lt3967dSJfX+tbIcOchsnLFVDSbDatUxf5xBqu6YHJXsp03VFQiCQbGgCJJTzYt/r2kZc2rxooR8m+cBdOkznflFSiFDSHl6ScNaVZFCAQJ10CtyIswAyeglxoJ6brv/Xs+m8/v314ojX04tqwzIKysH1wOV6YRtzFUdk/KEDhFWRSsu42pUibg7lVy0Zjk9rV/Hg3LLRB9z9a0CCqsHaJ801JNxSwTAiY0VYrGJls+OZTG77zwsbB8baM4tqwzMkJKZH2/Wa/rz2gl6972pszRrU2TLU2TsY2iUYV2CkNbUKycDUqgYLSxKrCXAuD63RlQgH2+84vefLg+qePrLkw1RJoWxdGLGAdl5nul78WvYQfMKAOA8cHirHU2TZZF5ZLJpmQqKAzr9dy+ZrMf1sEWBAtKRQ/ZA9laiZz8NiqJw+vP/zystlSLqNNbVgSIcuJW5Z5I74mnZkfBqBJpxQsUPeSi57iUoTzrD7M234FufnGe/rBMcwIKFpBRokimy9mj51pf+HoqgMnuocutlrxM36UaqVCrPT65Vp3uH4ogDqzRwKzouOi+8wBTLcCzpPzC6ol10B2pyhCX4unBRgm85mTQ+1HTq84dKp74EJryYQBccY3gEUWfIWBww+kWfhDARQAgJlqwtKylonYJskzJLMQiUbaJHMSRaBItAIiYMa5YnbwQsPZwfajZ5e+3L90dKI+tr5H7HumTpdEwAKCEC5sHF8zA39zACqABFFMS5dMtzZOWUOUdD6ECFGJQgGVbOyKrCqV/bHZmpGJhv7zLX3DHQMjzaMT9YUoFKBAWV9z6JWd/lqe39y++AbTv3pAJdlaiWEQgyLDSlhxrMpGl2M/XwrzxWBqrnZiNjs2mRubqLs4XT8xW1MoZiNBBaSJPW1zYQQAnHz4BkD6OU4Ar9FEu+bu7If0aygT9qGtcUYrY6yKLUZGlWMvjnVstGHlaiIC0SRKs0JOmhjzsxSXVA1vknGKH44PTfk+GhxrTkeUoNJhDjwJ0VRIlvmPoUrIqEQVFzGs+W8G0JQ1lkAbuOxjvtJhsAWEc6qBrrZ5M472/HABTUMGzu9ZeEXr61XGHOBNqZFvFkBfFSy4wn/+NR3VT7itAloFtApo9agCWgW0Cmj1qAJaBbQKaPWoAloFtApoFdDqUQW0CmgV0OpRBbQKaBXQ6vFax/8Hq2rCqnGXXpAAAAAVdEVYdHBkZjpBdXRob3IAU3VwZXJ2aXNvcq7E1dIAAACjelRYdHhtcDpDcmVhdG9yVG9vbAAACJklizsOwkAMBa/iElqgoNkihI+QVoCCggSdia2wfLyJs+E+QMFB9mIkohpp5r0U5YkwyFiIlXUI5AszT1aLOnfahAm0DavJk+V0Y/ej0/gIZ0UhM+tNSpe8LCHwo7pjYLPzTYAKFcE6uTGtBYghVYfxGz8esviqHPW1bjv+5VbL+BZXeDiwdnPb/eWKPy8QOQUV5AGlAAAAAElFTkSuQmCC" 
                  alt="Logo Tutts" 
                  className="w-28 h-28 mx-auto mb-4 rounded-xl shadow-lg object-cover"
                />
                <h1 className="text-2xl font-bold text-gray-800">Sistema Tutts</h1>
                <p className="text-gray-500 text-sm">Solicitações e Saque Emergencial</p>
              </div>

              {formData.view === 'register' ? (
                <div className="space-y-4">
                  {/* Loading da planilha */}
                  {sheetLoading && (
                    <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-center">
                      <p className="text-blue-700 text-sm">📊 Carregando lista de profissionais...</p>
                    </div>
                  )}
                  
                  {/* Erro ao carregar planilha */}
                  {sheetError && (
                    <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-center">
                      <p className="text-red-700 text-sm">❌ {sheetError}</p>
                      <button onClick={loadProfissionaisSheet} className="text-red-600 text-xs underline mt-1">Tentar novamente</button>
                    </div>
                  )}
                  
                  {/* Campo Código - PRIMEIRO */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Código Profissional</label>
                    <input 
                      type="text" 
                      placeholder="Digite seu código" 
                      value={formData.cod || ''} 
                      onChange={e => setFormData({...formData, cod: e.target.value})} 
                      className={`w-full px-4 py-3 border rounded-lg ${formData.cod && !sheetLoading ? (formData.codValido ? 'border-green-500 bg-green-50' : 'border-red-500 bg-red-50') : ''}`}
                    />
                    {formData.cod && !sheetLoading && !formData.codValido && (
                      <p className="text-red-600 text-sm mt-1">❌ Código não encontrado na base</p>
                    )}
                    {formData.cod && formData.codValido && (
                      <p className="text-green-600 text-sm mt-1">✅ Código válido!</p>
                    )}
                  </div>
                  
                  {/* Campo Nome - BLOQUEADO (vem da planilha) */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Nome Completo</label>
                    <input 
                      type="text" 
                      placeholder={formData.codValido ? "Nome carregado automaticamente" : "Digite o código primeiro"} 
                      value={formData.name || ''} 
                      readOnly
                      className={`w-full px-4 py-3 border rounded-lg bg-gray-100 cursor-not-allowed ${formData.name ? 'border-green-500 bg-green-50' : ''}`}
                    />
                    {formData.name && (
                      <p className="text-green-600 text-xs mt-1">🔒 Nome vinculado ao código</p>
                    )}
                  </div>
                  
                  {/* Campo Senha */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Senha</label>
                    <input 
                      type="password" 
                      placeholder="Crie sua senha" 
                      value={formData.password || ''} 
                      onChange={e => setFormData({...formData, password: e.target.value})} 
                      className="w-full px-4 py-3 border rounded-lg"
                      disabled={!formData.codValido}
                    />
                  </div>
                  
                  {/* Campo Confirmar Senha */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Confirmar Senha</label>
                    <input 
                      type="password" 
                      placeholder="Digite a senha novamente" 
                      value={formData.confirmPassword || ''} 
                      onChange={e => setFormData({...formData, confirmPassword: e.target.value})} 
                      className={`w-full px-4 py-3 border rounded-lg ${formData.confirmPassword ? (formData.password === formData.confirmPassword ? 'border-green-500 bg-green-50' : 'border-red-500 bg-red-50') : ''}`}
                      disabled={!formData.codValido || !formData.password}
                    />
                    {formData.confirmPassword && formData.password !== formData.confirmPassword && (
                      <p className="text-red-600 text-sm mt-1">❌ As senhas não coincidem</p>
                    )}
                    {formData.confirmPassword && formData.password === formData.confirmPassword && (
                      <p className="text-green-600 text-sm mt-1">✅ Senhas conferem!</p>
                    )}
                  </div>
                  
                  <button 
                    onClick={handleRegister} 
                    disabled={loading || !formData.codValido || !formData.password || !formData.confirmPassword || formData.password !== formData.confirmPassword} 
                    className="w-full bg-purple-900 text-white py-3 rounded-lg font-semibold hover:bg-purple-800 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {loading ? 'Aguarde...' : 'Criar Conta'}
                  </button>
                  <button onClick={() => setFormData({view: 'login'})} className="w-full text-purple-700 text-sm">← Voltar</button>
                </div>
              ) : formData.view === 'recuperar' ? (
                <div className="space-y-4">
                  <div className="bg-purple-50 border border-purple-200 rounded-lg p-6 text-center">
                    <p className="text-5xl mb-4">🔐</p>
                    <h2 className="text-xl font-bold text-purple-800 mb-2">Esqueceu sua senha?</h2>
                    <p className="text-gray-600 mb-4">Entre em contato com o suporte Tutts para obter uma nova senha.</p>
                    
                    <div className="bg-white rounded-lg p-4 border border-purple-300">
                      <p className="text-sm text-gray-500 mb-1">📞 Contato Suporte</p>
                      <a href="https://wa.me/5571989260372" target="_blank" className="text-2xl font-bold text-green-600 hover:text-green-700">
                        (71) 98926-0372
                      </a>
                      <p className="text-xs text-gray-400 mt-2">Clique para abrir o WhatsApp</p>
                    </div>
                  </div>
                  <button onClick={() => setFormData({view: 'login'})} className="w-full bg-purple-900 text-white py-3 rounded-lg font-semibold hover:bg-purple-800">
                    ← Voltar ao Login
                  </button>
                </div>
              ) : (
                <div className="space-y-4">
                  <input type="text" placeholder="Código Profissional" value={formData.cod || ''} onChange={e => setFormData({...formData, cod: e.target.value})} className="w-full px-4 py-3 border rounded-lg" />
                  <input type="password" placeholder="Senha" value={formData.password || ''} onChange={e => setFormData({...formData, password: e.target.value})} onKeyDown={e => e.key === 'Enter' && handleLogin()} className="w-full px-4 py-3 border rounded-lg" />
                  <button onClick={handleLogin} disabled={loading} className="w-full bg-purple-900 text-white py-3 rounded-lg font-semibold hover:bg-purple-800 disabled:opacity-50">
                    {loading ? 'Entrando...' : 'Entrar'}
                  </button>
                  <div className="flex justify-between text-sm">
                    <button onClick={() => setFormData({view: 'register'})} className="text-purple-700 hover:underline">Criar nova conta</button>
                    <button onClick={() => setFormData({view: 'recuperar'})} className="text-gray-500 hover:underline">Esqueci minha senha</button>
                  </div>
                </div>
              )}
            </div>
          </div>
        );
      }

      // ========== PAINEL DO USUÁRIO ==========
      if (user.role === 'user') {
        return (
          <div className="min-h-screen bg-gray-50">
            {toast && <Toast {...toast} />}
            {globalLoading && <LoadingOverlay />}
            {imageModal && <ImageModal imageUrl={imageModal} onClose={() => setImageModal(null)} />}

            <nav className="bg-gradient-to-r from-purple-800 to-purple-900 shadow-lg">
              <div className="max-w-7xl mx-auto px-4 py-4 flex justify-between items-center">
                <div>
                  <h1 className="text-xl font-bold text-white">Sistema Tutts</h1>
                  <p className="text-sm text-purple-200">{user.fullName}</p>
                </div>
                <div className="flex gap-2">
                  {formData.userTab && (
                    <button onClick={() => setFormData({...formData, userTab: null})} className="px-4 py-2 bg-white/20 text-white rounded-lg hover:bg-white/30 text-sm font-semibold">
                      🏠 Menu
                    </button>
                  )}
                  <button onClick={refreshAll} className="px-4 py-2 bg-white/20 text-white rounded-lg hover:bg-white/30 text-sm font-semibold">🔄</button>
                  <button onClick={() => setUser(null)} className="px-4 py-2 bg-white/10 text-white hover:bg-white/20 rounded-lg">Sair</button>
                </div>
              </div>
            </nav>

            {/* MENU INICIAL */}
            {!formData.userTab && (
              <div className="max-w-2xl mx-auto p-6">
                <div className="text-center mb-8">
                  <h2 className="text-2xl font-bold text-gray-800">Olá, {user.fullName?.split(' ')[0]}! 👋</h2>
                  <p className="text-gray-600 mt-1">O que você precisa fazer hoje?</p>
                </div>
                
                <div className="space-y-4">
                  {/* Botão Ajustes */}
                  <button 
                    onClick={() => setFormData({...formData, userTab: 'solicitacoes'})}
                    className="w-full bg-white rounded-2xl shadow-lg p-6 flex items-center gap-4 hover:shadow-xl transition-all hover:scale-[1.02] border-l-4 border-purple-600"
                  >
                    <div className="w-16 h-16 bg-purple-100 rounded-xl flex items-center justify-center text-3xl">
                      📋
                    </div>
                    <div className="text-left flex-1">
                      <h3 className="text-lg font-bold text-gray-800">Solicitar Ajuste</h3>
                      <p className="text-sm text-gray-500">Retornos e Pedágios</p>
                    </div>
                    <span className="text-purple-400 text-2xl">›</span>
                  </button>

                  {/* Botão Saque */}
                  <button 
                    onClick={() => setFormData({...formData, userTab: 'saque'})}
                    className="w-full bg-white rounded-2xl shadow-lg p-6 flex items-center gap-4 hover:shadow-xl transition-all hover:scale-[1.02] border-l-4 border-green-600"
                  >
                    <div className="w-16 h-16 bg-green-100 rounded-xl flex items-center justify-center text-3xl">
                      💰
                    </div>
                    <div className="text-left flex-1">
                      <h3 className="text-lg font-bold text-gray-800">Saque Emergencial</h3>
                      <p className="text-sm text-gray-500">Solicitar adiantamento</p>
                    </div>
                    <span className="text-green-400 text-2xl">›</span>
                  </button>

                  {/* Botão Indicações */}
                  <button 
                    onClick={() => setFormData({...formData, userTab: 'indicacoes'})}
                    className="w-full bg-white rounded-2xl shadow-lg p-6 flex items-center gap-4 hover:shadow-xl transition-all hover:scale-[1.02] border-l-4 border-blue-600"
                  >
                    <div className="w-16 h-16 bg-blue-100 rounded-xl flex items-center justify-center text-3xl">
                      👥
                    </div>
                    <div className="text-left flex-1">
                      <h3 className="text-lg font-bold text-gray-800">Promoção de Indicação</h3>
                      <p className="text-sm text-gray-500">Indique amigos e ganhe bônus</p>
                      {promocoes.length > 0 && (
                        <span className="inline-block mt-1 px-2 py-0.5 bg-blue-500 text-white text-xs rounded-full">
                          {promocoes.length} promoção(ões) ativa(s)
                        </span>
                      )}
                    </div>
                    <span className="text-blue-400 text-2xl">›</span>
                  </button>

                  {/* Botão Seguro de Vida IZA */}
                  <button 
                    onClick={() => setFormData({...formData, userTab: 'seguro-iza'})}
                    className="w-full bg-white rounded-2xl shadow-lg p-6 flex items-center gap-4 hover:shadow-xl transition-all hover:scale-[1.02] border-l-4 border-cyan-500"
                  >
                    <div className="w-16 h-16 bg-cyan-100 rounded-xl flex items-center justify-center text-3xl">
                      🛡️
                    </div>
                    <div className="text-left flex-1">
                      <h3 className="text-lg font-bold text-gray-800">Seguro de Vida - IZA</h3>
                      <p className="text-sm text-gray-500">Coberturas, valores e como acionar</p>
                    </div>
                    <span className="text-cyan-400 text-2xl">›</span>
                  </button>

                  {/* Botão Promoções Novatos - Apenas para COD >= 14000 e dentro de 30 dias */}
                  {isNovato() && (
                    <button 
                      onClick={() => setFormData({...formData, userTab: 'promo-novatos'})}
                      className="w-full bg-white rounded-2xl shadow-lg p-6 flex items-center gap-4 hover:shadow-xl transition-all hover:scale-[1.02] border-l-4 border-orange-500"
                    >
                      <div className="w-16 h-16 bg-orange-100 rounded-xl flex items-center justify-center text-3xl">
                        🚀
                      </div>
                      <div className="text-left flex-1">
                        <h3 className="text-lg font-bold text-gray-800">Promoções Novatos</h3>
                        <p className="text-sm text-gray-500">Promoções especiais para novos profissionais</p>
                        <div className="flex gap-2 mt-1 flex-wrap">
                          {promocoesNovatos.length > 0 && (
                            <span className="inline-block px-2 py-0.5 bg-orange-500 text-white text-xs rounded-full">
                              {promocoesNovatos.length} promoção(ões)
                            </span>
                          )}
                          <span className="inline-block px-2 py-0.5 bg-red-100 text-red-700 text-xs rounded-full font-semibold">
                            ⏰ {diasRestantesNovato()} dias restantes
                          </span>
                        </div>
                      </div>
                      <span className="text-orange-400 text-2xl">›</span>
                    </button>
                  )}
                </div>

                {/* Mini resumo */}
                <div className="mt-8 grid grid-cols-3 gap-4">
                  <div className="bg-white rounded-xl p-4 text-center shadow">
                    <p className="text-2xl font-bold text-purple-600">{submissions.filter(s => s.status === 'pendente').length}</p>
                    <p className="text-xs text-gray-500">Ajustes Pendentes</p>
                  </div>
                  <div className="bg-white rounded-xl p-4 text-center shadow">
                    <p className="text-2xl font-bold text-green-600">{withdrawals.filter(w => w.status === 'aguardando_aprovacao').length}</p>
                    <p className="text-xs text-gray-500">Saques Pendentes</p>
                  </div>
                  <div className="bg-white rounded-xl p-4 text-center shadow">
                    <p className="text-2xl font-bold text-blue-600">{minhasIndicacoes.filter(i => i.status === 'pendente').length}</p>
                    <p className="text-xs text-gray-500">Indicações Pendentes</p>
                  </div>
                </div>
              </div>
            )}

            {/* CONTEÚDO DAS ABAS */}
            {formData.userTab && (
              <div className="max-w-4xl mx-auto p-6">
                {/* Header de navegação */}
                <div className="flex items-center gap-4 mb-6">
                  <button 
                    onClick={() => setFormData({...formData, userTab: null})}
                    className="p-2 bg-white rounded-lg shadow hover:bg-gray-50"
                  >
                    ← Voltar
                  </button>
                  <h1 className="text-xl font-bold text-gray-800">
                    {formData.userTab === 'solicitacoes' && '📋 Solicitar Ajuste'}
                    {formData.userTab === 'saque' && '💰 Saque Emergencial'}
                    {formData.userTab === 'indicacoes' && '👥 Promoção de Indicação'}
                    {formData.userTab === 'promo-novatos' && '🚀 Promoções Novatos'}
                    {formData.userTab === 'seguro-iza' && '🛡️ Seguro de Vida - IZA'}
                  </h1>
                </div>

              {/* ABA SOLICITAÇÕES */}
              {formData.userTab === 'solicitacoes' && (
                <>
                  <div className="bg-white rounded-xl shadow p-6 mb-6">
                    <h2 className="text-lg font-semibold mb-4">📝 Enviar OS</h2>
                    <div className="space-y-4">
                      <input type="text" placeholder="Número da OS" value={formData.os || ''} onChange={e => setFormData({...formData, os: e.target.value})} className="w-full px-4 py-3 border rounded-lg" />
                      <select value={formData.motivo || ''} onChange={e => {
                        const m = e.target.value;
                        setFormData({...formData, motivo: m, imagens: []});
                      }} className="w-full px-4 py-3 border rounded-lg">
                        <option value="">Selecione o motivo</option>
                        <option>Ajuste de Retorno</option>
                        <option>Ajuste de Pedágio (Campinas e Recife)</option>
                      </select>

                      {motivosComFoto.includes(formData.motivo) && (
                        <div className="border-2 border-dashed border-orange-300 bg-orange-50 rounded-lg p-4">
                          <p className="text-sm font-bold text-orange-800 mb-2">📎 Fotos OBRIGATÓRIAS (máx. 2)</p>
                          <input type="file" accept="image/*" multiple onChange={async (e) => {
                            const files = Array.from(e.target.files).slice(0, 2);
                            if (!files.length) return;
                            setLoading(true);
                            try {
                              const compressed = [];
                              for (const f of files) { if (f.size <= 10000000) compressed.push(await compressImage(f)); }
                              setFormData({...formData, imagens: [...(formData.imagens || []), ...compressed].slice(0, 2)});
                              showToast('✅ Imagem adicionada!', 'success');
                            } catch { showToast('Erro', 'error'); }
                            setLoading(false);
                            e.target.value = '';
                          }} className="w-full text-sm" />
                          {formData.imagens?.length > 0 && (
                            <div className="mt-3 flex gap-2">
                              {formData.imagens.map((img, i) => (
                                <div key={i} className="relative">
                                  <img src={img} className="h-24 rounded border" />
                                  <button onClick={() => setFormData({...formData, imagens: formData.imagens.filter((_, idx) => idx !== i)})} className="absolute -top-2 -right-2 bg-red-600 text-white rounded-full w-5 h-5 text-xs">✕</button>
                                </div>
                              ))}
                            </div>
                          )}
                          <p className="text-xs text-gray-500 mt-2">{formData.imagens?.length || 0}/2 fotos</p>
                        </div>
                      )}

                      <button onClick={handleSubmitOS} disabled={loading || !formData.os || !formData.motivo || (motivosComFoto.includes(formData.motivo) && (!formData.imagens?.length))} className="w-full bg-purple-900 text-white py-3 rounded-lg font-semibold disabled:opacity-50">
                        {loading ? '⏳ Enviando...' : 'Enviar'}
                      </button>
                    </div>
                  </div>

                  <div className="bg-white rounded-xl shadow p-6">
                    <h2 className="text-lg font-semibold mb-4">📋 Minhas Submissões</h2>
                    {submissions.length === 0 ? <p className="text-gray-500">Nenhuma submissão</p> : (
                      <div className="space-y-3">
                        {submissions.map(s => (
                          <div key={s.id} className="border rounded-lg p-4">
                            <div className="flex justify-between items-start">
                              <div>
                                <p className="font-mono text-lg font-bold">OS: {s.ordemServico}</p>
                                <p className="text-sm text-gray-600">{s.motivo}</p>
                              </div>
                              <span className={`px-3 py-1 rounded-full text-xs font-bold ${s.status === 'aprovada' ? 'bg-green-500 text-white' : s.status === 'rejeitada' ? 'bg-red-500 text-white' : 'bg-yellow-500 text-white'}`}>{s.status?.toUpperCase()}</span>
                            </div>
                            {/* Mostrar motivo da rejeição */}
                            {s.status === 'rejeitada' && s.observacao && (
                              <div className="mt-2 p-2 bg-red-50 border border-red-200 rounded">
                                <p className="text-xs text-red-800"><strong>Motivo da rejeição:</strong> {s.observacao}</p>
                              </div>
                            )}
                            {s.temImagem && !s.imagemComprovante && <button onClick={() => loadImagem(s.id)} className="mt-2 text-sm text-blue-600 hover:underline">📷 Ver foto(s)</button>}
                            {s.imagemComprovante && (
                              <div className="mt-2 flex gap-2">
                                {s.imagemComprovante.split('|||').map((img, i) => <img key={i} src={img} className="h-20 rounded cursor-pointer" onClick={() => setImageModal(img)} />)}
                              </div>
                            )}
                            <p className="text-xs text-gray-400 mt-2">{s.timestamp}</p>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              )}

              {/* ABA SAQUE */}
              {formData.userTab === 'saque' && (
                <>
                  {/* Verificando horário */}
                  {horarioVerificado === null ? (
                    <div className="flex items-center justify-center py-12">
                      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-purple-600"></div>
                      <span className="ml-3">Verificando horário...</span>
                    </div>
                  ) : !horarioVerificado.dentroHorario && !horarioAceito ? (
                    /* Fora do horário - mostrar slider de confirmação */
                    <div className="space-y-4">
                      {/* Avisos */}
                      {avisosUsuario.map(av => (
                        <div key={av.id} className={`p-4 rounded-xl border-l-4 ${
                          av.tipo === 'error' ? 'bg-red-50 border-red-500' :
                          av.tipo === 'warning' ? 'bg-yellow-50 border-yellow-500' :
                          av.tipo === 'success' ? 'bg-green-50 border-green-500' :
                          'bg-blue-50 border-blue-500'
                        }`}>
                          <p className="font-bold text-sm mb-1">{av.titulo}</p>
                          <p className="text-sm text-gray-700">{av.mensagem}</p>
                        </div>
                      ))}
                      
                      {/* Aviso de fora do horário */}
                      <div className="bg-orange-50 border-2 border-orange-400 rounded-2xl p-6">
                        <div className="text-center mb-6">
                          <div className="text-6xl mb-4">🕐</div>
                          <h2 className="text-xl font-bold text-orange-800 mb-2">Fora do Horário de Atendimento</h2>
                          <p className="text-orange-700">
                            O atendimento de saques estará disponível novamente <strong>{formatarProximoHorario()}</strong>.
                          </p>
                        </div>
                        
                        <div className="bg-white rounded-xl p-4 mb-6">
                          <p className="text-sm text-gray-700 text-center">
                            ⚠️ Você pode solicitar o saque agora, mas ele só será processado quando o atendimento reabrir.
                          </p>
                        </div>
                        
                        {/* Slider de confirmação */}
                        <div className="bg-orange-100 rounded-xl p-4">
                          <p className="text-sm font-semibold text-orange-800 mb-4 text-center">
                            Arraste o cursor para confirmar que entendeu:
                          </p>
                          <div 
                            className="relative h-14 bg-orange-200 rounded-full overflow-hidden touch-none select-none"
                            onTouchStart={e => {
                              const touch = e.touches[0];
                              const rect = e.currentTarget.getBoundingClientRect();
                              const percent = Math.max(0, Math.min(100, ((touch.clientX - rect.left) / rect.width) * 100));
                              setSliderValue(percent);
                            }}
                            onTouchMove={e => {
                              const touch = e.touches[0];
                              const rect = e.currentTarget.getBoundingClientRect();
                              const percent = Math.max(0, Math.min(100, ((touch.clientX - rect.left) / rect.width) * 100));
                              setSliderValue(percent);
                              if (percent >= 95 && !horarioAceito) {
                                setHorarioAceito(true);
                                showToast('✅ Você pode prosseguir com a solicitação!', 'success');
                              }
                            }}
                            onMouseDown={e => {
                              const rect = e.currentTarget.getBoundingClientRect();
                              const percent = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
                              setSliderValue(percent);
                              
                              const handleMouseMove = (moveEvent) => {
                                const newPercent = Math.max(0, Math.min(100, ((moveEvent.clientX - rect.left) / rect.width) * 100));
                                setSliderValue(newPercent);
                                if (newPercent >= 95 && !horarioAceito) {
                                  setHorarioAceito(true);
                                  showToast('✅ Você pode prosseguir com a solicitação!', 'success');
                                }
                              };
                              
                              const handleMouseUp = () => {
                                document.removeEventListener('mousemove', handleMouseMove);
                                document.removeEventListener('mouseup', handleMouseUp);
                              };
                              
                              document.addEventListener('mousemove', handleMouseMove);
                              document.addEventListener('mouseup', handleMouseUp);
                            }}
                          >
                            {/* Barra de progresso */}
                            <div 
                              className="absolute top-0 left-0 h-full bg-gradient-to-r from-orange-400 via-yellow-400 to-green-500 rounded-full"
                              style={{ 
                                width: `${sliderValue}%`,
                                transition: 'none'
                              }}
                            />
                            
                            {/* Cursor arrastável */}
                            <div 
                              className="absolute top-1 w-12 h-12 bg-white rounded-full shadow-lg flex items-center justify-center text-2xl pointer-events-none border-2 border-orange-300"
                              style={{ 
                                left: `calc(${sliderValue}% - ${sliderValue * 0.48}px)`,
                                transition: 'none',
                                transform: sliderValue >= 95 ? 'scale(1.1)' : 'scale(1)'
                              }}
                            >
                              {sliderValue < 95 ? '👉' : '✅'}
                            </div>
                            
                            {/* Texto de instrução */}
                            <div className="absolute inset-0 flex items-center justify-end pr-4 pointer-events-none">
                              <span className={`font-bold text-sm ${sliderValue < 95 ? 'text-orange-700' : 'text-green-700'}`}>
                                {sliderValue < 30 ? 'Arraste →→→' : sliderValue < 95 ? 'Continue →' : '✓ OK!'}
                              </span>
                            </div>
                          </div>
                          
                        </div>
                      </div>
                    </div>
                  ) : (
                    /* Dentro do horário ou já aceitou - mostrar formulário */
                    <>
                      {/* Avisos */}
                      {avisosUsuario.length > 0 && (
                        <div className="space-y-2 mb-4">
                          {avisosUsuario.map(av => (
                            <div key={av.id} className={`p-3 rounded-xl border-l-4 ${
                              av.tipo === 'error' ? 'bg-red-50 border-red-500' :
                              av.tipo === 'warning' ? 'bg-yellow-50 border-yellow-500' :
                              av.tipo === 'success' ? 'bg-green-50 border-green-500' :
                              'bg-blue-50 border-blue-500'
                            }`}>
                              <p className="font-bold text-sm">{av.titulo}</p>
                              <p className="text-xs text-gray-700">{av.mensagem}</p>
                            </div>
                          ))}
                        </div>
                      )}
                      
                      {/* Indicador de horário se estiver fora */}
                      {horarioVerificado && !horarioVerificado.dentroHorario && horarioAceito && (
                        <div className="bg-orange-100 border border-orange-300 rounded-xl p-3 mb-4 flex items-center gap-3">
                          <span className="text-2xl">⏰</span>
                          <div>
                            <p className="text-sm font-semibold text-orange-800">Solicitação fora do horário</p>
                            <p className="text-xs text-orange-700">Será processada {formatarProximoHorario()}</p>
                          </div>
                        </div>
                      )}
                      
                      {!termsAccepted ? (
                        <div className="bg-white rounded-xl shadow p-6">
                          <h2 className="text-2xl font-bold text-purple-900 mb-4 text-center">📋 Termos de Uso</h2>
                          <div className="bg-gray-50 rounded-lg p-4 mb-6 max-h-80 overflow-y-auto text-sm">
                            <p className="text-gray-700 leading-relaxed">Uma taxa administrativa de 4,5% será aplicada sobre o valor solicitado e deduzida automaticamente na transferência. As solicitações são processadas de segunda a sexta, das 09:00 às 18:00, e aos sábados, das 08:00 às 12:00. Solicitações feitas fora desse horário serão atendidas no próximo dia útil. É sua responsabilidade garantir que as informações fornecidas estejam corretas, pois não nos responsabilizamos por atrasos ou transferências erradas causadas por dados incorretos. O dinheiro será transferido em até 1 hora após a confirmação, dentro do horário de funcionamento.</p>
                          </div>
                          <button onClick={handleAcceptTerms} disabled={loading} className="w-full bg-purple-600 text-white py-3 rounded-lg font-bold disabled:opacity-50">
                            {loading ? 'Aguarde...' : '✓ Aceitar e Continuar'}
                          </button>
                        </div>
                      ) : !financialData?.full_name ? (
                        <div className="bg-white rounded-xl shadow p-6">
                          <h2 className="text-xl font-bold text-purple-900 mb-4">💳 Cadastrar Dados Financeiros</h2>
                          <p className="text-sm text-gray-600 mb-4">Preencha seus dados para receber os saques via PIX.</p>
                          <div className="space-y-4">
                            <div>
                              <label className="block text-sm font-semibold mb-1">Código do Profissional</label>
                              <input type="text" value={user.codProfissional} disabled className="w-full px-4 py-2 border rounded-lg bg-gray-100 text-gray-600" />
                            </div>
                        
                            <div>
                          <label className="block text-sm font-semibold mb-1">Nome Completo *</label>
                          <input 
                            type="text" 
                            value={formData.finName || ''} 
                            onChange={e => setFormData({...formData, finName: e.target.value})} 
                            className="w-full px-4 py-2 border rounded-lg" 
                            placeholder="Seu nome completo"
                          />
                        </div>
                        
                        <div>
                          <label className="block text-sm font-semibold mb-1">CPF *</label>
                          <input 
                            type="text" 
                            value={formData.finCpf || ''} 
                            onChange={e => setFormData({...formData, finCpf: formatCPF(e.target.value)})} 
                            className="w-full px-4 py-2 border rounded-lg" 
                            placeholder="000.000.000-00"
                            maxLength={14}
                          />
                        </div>
                        
                        {/* Tipo da Chave PIX */}
                        <div>
                          <label className="block text-sm font-semibold mb-2">Tipo da Chave PIX *</label>
                          <div className="grid grid-cols-5 gap-2">
                            {[
                              { id: 'cpf', label: 'CPF', icon: '🪪' },
                              { id: 'cnpj', label: 'CNPJ', icon: '🏢' },
                              { id: 'telefone', label: 'Telefone', icon: '📱' },
                              { id: 'email', label: 'Email', icon: '📧' },
                              { id: 'aleatoria', label: 'Aleatória', icon: '🔑' }
                            ].map(tipo => (
                              <button
                                key={tipo.id}
                                type="button"
                                onClick={() => setFormData({...formData, pixTipo: tipo.id, finPix: ''})}
                                className={`p-2 rounded-lg border-2 text-center transition-all ${
                                  formData.pixTipo === tipo.id 
                                    ? 'border-purple-500 bg-purple-50 text-purple-700' 
                                    : 'border-gray-200 hover:border-gray-300'
                                }`}
                              >
                                <span className="text-xl">{tipo.icon}</span>
                                <p className="text-xs font-semibold mt-1">{tipo.label}</p>
                              </button>
                            ))}
                          </div>
                        </div>
                        
                        {/* Campo da Chave PIX */}
                        <div>
                          <label className="block text-sm font-semibold mb-1">Chave PIX *</label>
                          <input 
                            type={formData.pixTipo === 'email' ? 'email' : 'text'}
                            value={formData.finPix || ''} 
                            onChange={e => setFormData({
                              ...formData, 
                              finPix: formatarChavePix(e.target.value, formData.pixTipo)
                            })} 
                            placeholder={getPixPlaceholder(formData.pixTipo)}
                            disabled={!formData.pixTipo}
                            maxLength={formData.pixTipo === 'cpf' ? 14 : formData.pixTipo === 'cnpj' ? 18 : formData.pixTipo === 'telefone' ? 15 : 100}
                            className={`w-full px-4 py-2 border rounded-lg transition-all ${
                              !formData.pixTipo 
                                ? 'bg-gray-100 cursor-not-allowed' 
                                : formData.finPix
                                  ? validarChavePix(formData.finPix, formData.pixTipo).valido 
                                    ? 'border-green-500 bg-green-50' 
                                    : 'border-red-500 bg-red-50'
                                  : ''
                            }`}
                          />
                          {formData.finPix && formData.pixTipo && (
                            <p className={`mt-1 text-sm ${
                              validarChavePix(formData.finPix, formData.pixTipo).valido 
                                ? 'text-green-600' 
                                : 'text-red-600'
                            }`}>
                              {validarChavePix(formData.finPix, formData.pixTipo).mensagem}
                            </p>
                          )}
                          {!formData.pixTipo && (
                            <p className="mt-1 text-sm text-gray-500">👆 Selecione o tipo da chave acima</p>
                          )}
                        </div>
                        
                        <button 
                          onClick={handleSaveFinancial} 
                          disabled={loading || !formData.pixTipo || !formData.finName || !formData.finCpf || !formData.finPix} 
                          className="w-full bg-purple-600 text-white py-3 rounded-lg font-bold disabled:opacity-50 disabled:cursor-not-allowed hover:bg-purple-700 transition"
                        >
                          {loading ? '⏳ Salvando...' : '💾 Salvar Dados'}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="bg-white rounded-xl shadow mb-6">
                        <div className="flex border-b overflow-x-auto">
                          <button onClick={() => setFormData({...formData, saqueTab: 'solicitar'})} className={`flex-1 py-3 font-semibold whitespace-nowrap px-2 ${(!formData.saqueTab || formData.saqueTab === 'solicitar') ? 'text-green-700 border-b-2 border-green-600' : 'text-gray-500'}`}>💰 Solicitar</button>
                          <button onClick={() => setFormData({...formData, saqueTab: 'gratuidades'})} className={`flex-1 py-3 font-semibold whitespace-nowrap px-2 ${formData.saqueTab === 'gratuidades' ? 'text-pink-700 border-b-2 border-pink-600' : 'text-gray-500'}`}>🎁 Gratuidades</button>
                          <button onClick={() => setFormData({...formData, saqueTab: 'dados'})} className={`flex-1 py-3 font-semibold whitespace-nowrap px-2 ${formData.saqueTab === 'dados' ? 'text-blue-700 border-b-2 border-blue-600' : 'text-gray-500'}`}>👤 Dados</button>
                          <button onClick={() => setFormData({...formData, saqueTab: 'dashboard'})} className={`flex-1 py-3 font-semibold whitespace-nowrap px-2 ${formData.saqueTab === 'dashboard' ? 'text-purple-700 border-b-2 border-purple-600' : 'text-gray-500'}`}>📊 Dashboard</button>
                        </div>
                        <div className="p-6">
                          {/* ========== ABA DASHBOARD ========== */}
                          {formData.saqueTab === 'dashboard' && (
                            <>
                              {(() => {
                                const now = new Date();
                                const mesAtual = now.getMonth();
                                const anoAtual = now.getFullYear();
                                
                                // Saques do mês atual
                                const saquesMesAtual = withdrawals.filter(w => {
                                  const d = new Date(w.created_at);
                                  return d.getMonth() === mesAtual && d.getFullYear() === anoAtual;
                                });
                                
                                // Saques aprovados do mês
                                const aprovadosMes = saquesMesAtual.filter(w => w.status === 'aprovado' || w.status === 'aprovado_gratuidade');
                                const totalSacadoMes = aprovadosMes.reduce((acc, w) => acc + parseFloat(w.final_amount || 0), 0);
                                
                                // Gratuidades usadas
                                const gratuidadesUsadas = userGratuities.reduce((acc, g) => acc + (g.quantity - g.remaining), 0);
                                const gratuidadesTotal = userGratuities.reduce((acc, g) => acc + g.quantity, 0);
                                
                                // Histórico últimos 6 meses para gráfico
                                const ultimos6Meses = [];
                                for (let i = 5; i >= 0; i--) {
                                  const d = new Date(anoAtual, mesAtual - i, 1);
                                  const mes = d.getMonth();
                                  const ano = d.getFullYear();
                                  const saquesMes = withdrawals.filter(w => {
                                    const dw = new Date(w.created_at);
                                    return dw.getMonth() === mes && dw.getFullYear() === ano && (w.status === 'aprovado' || w.status === 'aprovado_gratuidade');
                                  });
                                  const valor = saquesMes.reduce((acc, w) => acc + parseFloat(w.final_amount || 0), 0);
                                  ultimos6Meses.push({
                                    mes: d.toLocaleDateString('pt-BR', { month: 'short' }).replace('.', ''),
                                    valor,
                                    qtd: saquesMes.length
                                  });
                                }
                                const maxValor = Math.max(...ultimos6Meses.map(m => m.valor), 1);
                                
                                // Estatísticas gerais
                                const totalGeral = withdrawals.filter(w => w.status === 'aprovado' || w.status === 'aprovado_gratuidade').reduce((acc, w) => acc + parseFloat(w.final_amount || 0), 0);
                                const mediaSaque = aprovadosMes.length > 0 ? totalSacadoMes / aprovadosMes.length : 0;
                                
                                return (
                                  <div className="space-y-6">
                                    {/* Cards Resumo */}
                                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                                      <div className="bg-gradient-to-br from-green-500 to-emerald-600 rounded-xl p-4 text-white">
                                        <p className="text-xs opacity-80">💰 Sacado este mês</p>
                                        <p className="text-2xl font-bold mt-1">{formatMoney(totalSacadoMes)}</p>
                                        <p className="text-xs opacity-70 mt-1">{aprovadosMes.length} saque(s)</p>
                                      </div>
                                      <div className="bg-gradient-to-br from-purple-500 to-pink-600 rounded-xl p-4 text-white">
                                        <p className="text-xs opacity-80">🎁 Gratuidades</p>
                                        <p className="text-2xl font-bold mt-1">{gratuidadesUsadas}/{gratuidadesTotal}</p>
                                        <p className="text-xs opacity-70 mt-1">usadas/total</p>
                                      </div>
                                      <div className="bg-gradient-to-br from-orange-500 to-red-500 rounded-xl p-4 text-white">
                                        <p className="text-xs opacity-80">📈 Total Histórico</p>
                                        <p className="text-2xl font-bold mt-1">{formatMoney(totalGeral)}</p>
                                        <p className="text-xs opacity-70 mt-1">todos os tempos</p>
                                      </div>
                                    </div>
                                    
                                    {/* Gráfico de Barras - Últimos 6 meses */}
                                    <div className="bg-white border rounded-xl p-4">
                                      <h3 className="font-semibold mb-4">📊 Histórico de Saques (Últimos 6 meses)</h3>
                                      <div className="flex items-end justify-between gap-2 h-48">
                                        {ultimos6Meses.map((m, i) => (
                                          <div key={i} className="flex-1 flex flex-col items-center">
                                            <span className="text-xs text-gray-600 mb-1">{formatMoney(m.valor)}</span>
                                            <div 
                                              className="w-full bg-gradient-to-t from-green-500 to-emerald-400 rounded-t-lg transition-all duration-500"
                                              style={{ height: `${Math.max((m.valor / maxValor) * 100, 5)}%`, minHeight: '20px' }}
                                            />
                                            <span className="text-xs font-semibold mt-2 text-gray-700">{m.mes}</span>
                                            <span className="text-xs text-gray-500">{m.qtd} saque(s)</span>
                                          </div>
                                        ))}
                                      </div>
                                    </div>
                                    
                                    {/* Resumo Rápido */}
                                    <div className="bg-gray-50 rounded-xl p-4">
                                      <h3 className="font-semibold mb-3">📋 Resumo do Mês</h3>
                                      <div className="grid grid-cols-2 gap-4 text-sm">
                                        <div className="flex justify-between"><span className="text-gray-600">Média por saque:</span><span className="font-semibold">{formatMoney(mediaSaque)}</span></div>
                                        <div className="flex justify-between"><span className="text-gray-600">Pendentes:</span><span className="font-semibold text-yellow-600">{saquesMesAtual.filter(w => w.status === 'aguardando_aprovacao').length}</span></div>
                                        <div className="flex justify-between"><span className="text-gray-600">Aprovados:</span><span className="font-semibold text-green-600">{aprovadosMes.length}</span></div>
                                        <div className="flex justify-between"><span className="text-gray-600">Rejeitados:</span><span className="font-semibold text-red-600">{saquesMesAtual.filter(w => w.status === 'rejeitado').length}</span></div>
                                      </div>
                                    </div>
                                  </div>
                                );
                              })()}
                            </>
                          )}
                          
                          {/* ========== ABA SOLICITAR ========== */}
                          {(!formData.saqueTab || formData.saqueTab === 'solicitar') && (
                            <>
                              {/* Verifica se tem gratuidade ativa */}
                              {(() => {
                                const gratAtiva = userGratuities.find(g => g.status === 'ativa' && g.remaining > 0);
                                const temGratuidade = !!gratAtiva;
                                const valorMaxGratuidade = gratAtiva ? parseFloat(gratAtiva.value) : 0;
                                const valorDigitado = parseFloat(formData.withdrawAmount) || 0;
                                const valorExcedido = temGratuidade && valorDigitado > valorMaxGratuidade;
                                
                                // Calcular saques na última hora
                                const agora = new Date();
                                const umaHoraAtras = new Date(agora.getTime() - 60 * 60 * 1000);
                                const saquesUltimaHora = withdrawals.filter(w => new Date(w.created_at) >= umaHoraAtras);
                                const saquesRestantes = Math.max(0, 2 - saquesUltimaHora.length);
                                const valoresUsados = saquesUltimaHora.map(w => parseFloat(w.requested_amount));
                                const valorRepetido = valoresUsados.includes(valorDigitado) && valorDigitado > 0;
                                
                                // Calcular tempo para liberar próximo saque
                                let tempoRestante = null;
                                if (saquesUltimaHora.length >= 2) {
                                  const maisAntigo = new Date(Math.min(...saquesUltimaHora.map(w => new Date(w.created_at).getTime())));
                                  const liberaEm = new Date(maisAntigo.getTime() + 60 * 60 * 1000);
                                  const diffMs = liberaEm - agora;
                                  if (diffMs > 0) {
                                    tempoRestante = Math.ceil(diffMs / (60 * 1000));
                                  }
                                }
                                
                                return (
                                  <div className="space-y-4">
                                    {/* INDICADOR DE LIMITE DE SAQUES */}
                                    <div className={`rounded-lg p-4 border ${saquesRestantes === 0 ? 'bg-red-50 border-red-300' : saquesRestantes === 1 ? 'bg-orange-50 border-orange-300' : 'bg-blue-50 border-blue-300'}`}>
                                      <div className="flex items-center justify-between">
                                        <div className="flex items-center gap-2">
                                          <span className="text-2xl">{saquesRestantes === 0 ? '🚫' : saquesRestantes === 1 ? '⚠️' : '✅'}</span>
                                          <div>
                                            <p className={`font-semibold ${saquesRestantes === 0 ? 'text-red-800' : saquesRestantes === 1 ? 'text-orange-800' : 'text-blue-800'}`}>
                                              {saquesRestantes === 0 ? 'Limite atingido' : `${saquesRestantes} saque(s) disponível(is)`}
                                            </p>
                                            <p className={`text-xs ${saquesRestantes === 0 ? 'text-red-600' : saquesRestantes === 1 ? 'text-orange-600' : 'text-blue-600'}`}>
                                              {saquesRestantes === 0 
                                                ? `Aguarde ${tempoRestante || '?'} min para solicitar novamente` 
                                                : 'Máximo 2 saques por hora com valores diferentes'}
                                            </p>
                                          </div>
                                        </div>
                                        <div className="flex gap-1">
                                          {[0, 1].map(i => (
                                            <div key={i} className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold ${i < saquesUltimaHora.length ? 'bg-gray-400 text-white' : 'bg-green-500 text-white'}`}>
                                              {i < saquesUltimaHora.length ? '✓' : i + 1 - saquesUltimaHora.length}
                                            </div>
                                          ))}
                                        </div>
                                      </div>
                                      {valoresUsados.length > 0 && (
                                        <p className="text-xs mt-2 text-gray-600">
                                          Valores já usados na última hora: {valoresUsados.map(v => `R$ ${v.toFixed(2)}`).join(', ')}
                                        </p>
                                      )}
                                    </div>
                                    
                                    {/* Alerta para quem TEM gratuidade */}
                                    {temGratuidade && (
                                      <div className="bg-green-50 border border-green-300 rounded-lg p-4">
                                        <p className="text-green-800 font-semibold">🎁 Você possui gratuidade ativa!</p>
                                        <p className="text-green-700 text-sm mt-1">Valor máximo permitido: <strong>{formatMoney(valorMaxGratuidade)}</strong></p>
                                        <p className="text-green-600 text-xs mt-1">Restam {gratAtiva.remaining} uso(s) desta gratuidade</p>
                                      </div>
                                    )}
                                    
                                    {/* Alerta para quem NÃO TEM gratuidade */}
                                    {!temGratuidade && (
                                      <div className="bg-yellow-50 border border-yellow-300 rounded-lg p-4">
                                        <p className="text-yellow-800 font-semibold">⚠️ Atenção!</p>
                                        <p className="text-yellow-700 text-sm mt-1">Conforme termo de uso do saque emergencial, será cobrado um valor de <strong>4,5%</strong> na solicitação.</p>
                                      </div>
                                    )}
                                    
                                    <div>
                                      <label className="block text-sm font-semibold mb-1">Valor {temGratuidade && <span className="text-green-600 text-xs">(máx: {formatMoney(valorMaxGratuidade)})</span>}</label>
                                      <input type="number" value={formData.withdrawAmount || ''} onChange={e => setFormData({...formData, withdrawAmount: e.target.value})} className={`w-full px-4 py-3 border rounded-lg text-lg ${valorExcedido || valorRepetido ? 'border-red-500 bg-red-50' : ''}`} disabled={saquesRestantes === 0} />
                                      {valorExcedido && (
                                        <p className="text-red-600 text-sm mt-1 font-semibold">❌ Valor excede o limite da gratuidade ({formatMoney(valorMaxGratuidade)})</p>
                                      )}
                                      {valorRepetido && !valorExcedido && (
                                        <p className="text-red-600 text-sm mt-1 font-semibold">❌ Você já solicitou R$ {valorDigitado.toFixed(2)} na última hora. Escolha outro valor.</p>
                                      )}
                                    </div>
                                    
                                    {formData.withdrawAmount && parseFloat(formData.withdrawAmount) > 0 && !valorExcedido && !valorRepetido && (() => {
                                      const c = calcWithdraw(parseFloat(formData.withdrawAmount));
                                      return (
                                        <div className="bg-gray-50 rounded-lg p-4 space-y-2">
                                          <div className="flex justify-between"><span>Solicitado:</span><span className="font-bold">{formatMoney(formData.withdrawAmount)}</span></div>
                                          <div className="flex justify-between"><span>Taxa:</span><span className={c.hasGrat ? 'text-green-600 font-bold' : 'text-red-600'}>{c.hasGrat ? 'ISENTA' : `-${formatMoney(c.fee)}`}</span></div>
                                          <hr /><div className="flex justify-between text-lg"><span className="font-bold">Receber:</span><span className="font-bold text-green-700">{formatMoney(c.final)}</span></div>
                                        </div>
                                      );
                                    })()}
                                    
                                    <button onClick={handleRequestWithdrawal} disabled={loading || !formData.withdrawAmount || valorExcedido || valorRepetido || saquesRestantes === 0} className="w-full bg-green-600 text-white py-3 rounded-lg font-bold disabled:opacity-50">{loading ? '...' : saquesRestantes === 0 ? '🚫 Limite Atingido' : '💸 Solicitar'}</button>
                                  </div>
                                );
                              })()}
                              <h3 className="text-lg font-semibold mt-8 mb-4">📋 Histórico</h3>
                              {withdrawals.length === 0 ? <p className="text-gray-500">Nenhum saque</p> : (
                                <div className="space-y-3">
                                  {withdrawals.map(w => {
                                    const isDelayed = w.status === 'aguardando_aprovacao' && (Date.now() - new Date(w.created_at)) > 3600000;
                                    
                                    // Mensagens personalizadas para o usuário
                                    const getStatusMessage = () => {
                                      if (isDelayed) return '⚠️ ATRASADO';
                                      if (w.status === 'aprovado' || w.status === 'aprovado_gratuidade') return '✅ Aprovado';
                                      if (w.status === 'rejeitado') return '❌ Rejeitado';
                                      if (w.status === 'inativo') return '⚠️ Inativo';
                                      return '⏳ Aguardando';
                                    };
                                    
                                    const getStatusDescription = () => {
                                      if (w.status === 'aprovado' || w.status === 'aprovado_gratuidade') 
                                        return 'Saque aprovado, em instantes será feito a transferência para o seu banco!';
                                      if (w.status === 'inativo') 
                                        return 'Saque temporariamente inativo por questões técnicas';
                                      if (w.status === 'rejeitado' && w.reject_reason) 
                                        return `Motivo: ${w.reject_reason}`;
                                      return null;
                                    };
                                    
                                    const statusDesc = getStatusDescription();
                                    
                                    return (
                                      <div key={w.id} className={`border rounded-lg p-4 ${isDelayed ? 'border-red-400 bg-red-50' : w.status?.includes('aprovado') ? 'border-green-400 bg-green-50' : w.status === 'rejeitado' ? 'border-red-300 bg-red-50' : w.status === 'inativo' ? 'border-orange-300 bg-orange-50' : ''}`}>
                                        <div className="flex justify-between">
                                          <div><p className="font-bold">{formatMoney(w.requested_amount)}</p><p className="text-sm text-gray-600">Receber: {formatMoney(w.final_amount)}</p></div>
                                          <span className={`px-3 py-1 rounded-full text-xs font-bold h-fit ${w.status?.includes('aprovado') ? 'bg-green-500 text-white' : w.status === 'rejeitado' ? 'bg-red-500 text-white' : w.status === 'inativo' ? 'bg-orange-500 text-white' : 'bg-yellow-500 text-white'}`}>{getStatusMessage()}</span>
                                        </div>
                                        {statusDesc && <p className={`text-sm mt-2 font-semibold ${w.status?.includes('aprovado') ? 'text-green-700' : w.status === 'rejeitado' ? 'text-red-600' : 'text-orange-600'}`}>{statusDesc}</p>}
                                        {isDelayed && <p className="text-red-600 text-sm mt-2 font-semibold">Entre em contato com o suporte</p>}
                                        <p className="text-xs text-gray-400 mt-2">{new Date(w.created_at).toLocaleString('pt-BR')}</p>
                                      </div>
                                    );
                                  })}
                                </div>
                              )}
                            </>
                          )}
                          {formData.saqueTab === 'dados' && (
                            <div className="space-y-4">
                              {/* MODO VISUALIZAÇÃO - Dados já cadastrados */}
                              {financialData && !editandoDados ? (
                                <>
                                  {/* Card verde com dados confirmados */}
                                  <div className="bg-green-50 border-2 border-green-300 rounded-xl p-5">
                                    <div className="flex items-center gap-2 mb-4">
                                      <span className="text-2xl">✅</span>
                                      <h3 className="font-bold text-green-800">Dados Validados</h3>
                                    </div>
                                    
                                    <div className="space-y-3">
                                      <div className="flex justify-between items-center py-2 border-b border-green-200">
                                        <span className="text-gray-600 text-sm">Nome Completo</span>
                                        <span className="font-semibold text-gray-800">{financialData.full_name}</span>
                                      </div>
                                      <div className="flex justify-between items-center py-2 border-b border-green-200">
                                        <span className="text-gray-600 text-sm">CPF</span>
                                        <span className="font-semibold text-gray-800">{financialData.cpf}</span>
                                      </div>
                                      <div className="flex justify-between items-center py-2 border-b border-green-200">
                                        <span className="text-gray-600 text-sm">Tipo da Chave PIX</span>
                                        <span className="px-2 py-1 bg-green-200 text-green-800 rounded-full text-xs font-bold">
                                          {{cpf: '🪪 CPF', cnpj: '🏢 CNPJ', telefone: '📱 Telefone', email: '📧 Email', aleatoria: '🔑 Aleatória'}[financialData.pix_tipo] || financialData.pix_tipo}
                                        </span>
                                      </div>
                                      <div className="flex justify-between items-center py-2">
                                        <span className="text-gray-600 text-sm">Chave PIX</span>
                                        <span className="font-semibold text-gray-800">{financialData.pix_key}</span>
                                      </div>
                                    </div>
                                    
                                    <button 
                                      onClick={() => setEditandoDados(true)}
                                      className="w-full mt-4 bg-white border-2 border-green-500 text-green-700 py-3 rounded-lg font-bold hover:bg-green-100 transition"
                                    >
                                      ✏️ Editar Dados
                                    </button>
                                  </div>
                                  
                                  {/* Histórico de alterações */}
                                  {financialLogs.length > 0 && (
                                    <div className="bg-gray-50 border border-gray-200 rounded-xl p-4">
                                      <h4 className="font-semibold text-gray-700 mb-3 flex items-center gap-2">
                                        <span>📋</span> Histórico de Alterações
                                      </h4>
                                      <div className="space-y-2 max-h-48 overflow-y-auto">
                                        {financialLogs.map((log, idx) => (
                                          <div key={idx} className="bg-white border border-gray-200 rounded-lg p-3 text-sm">
                                            <div className="flex justify-between items-start">
                                              <div>
                                                <span className="font-semibold text-gray-700">
                                                  {log.action === 'ALTERACAO_NOME' && '👤 Nome alterado'}
                                                  {log.action === 'ALTERACAO_CPF' && '🪪 CPF alterado'}
                                                  {log.action === 'ALTERACAO_PIX' && '💳 Chave PIX alterada'}
                                                  {log.action === 'CADASTRO_DADOS' && '✅ Cadastro inicial'}
                                                </span>
                                                {log.old_value && log.new_value && (
                                                  <p className="text-gray-500 text-xs mt-1">
                                                    De: <span className="line-through text-red-500">{log.old_value}</span>
                                                    <br/>Para: <span className="text-green-600 font-medium">{log.new_value}</span>
                                                  </p>
                                                )}
                                              </div>
                                              <span className="text-xs text-gray-400">
                                                {new Date(log.created_at).toLocaleDateString('pt-BR')} {new Date(log.created_at).toLocaleTimeString('pt-BR', {hour: '2-digit', minute: '2-digit'})}
                                              </span>
                                            </div>
                                          </div>
                                        ))}
                                      </div>
                                    </div>
                                  )}
                                </>
                              ) : (
                                /* MODO EDIÇÃO - Formulário */
                                <>
                                  {financialData && editandoDados && (
                                    <div className="bg-yellow-50 border border-yellow-300 rounded-lg p-3 mb-2">
                                      <p className="text-yellow-800 text-sm flex items-center gap-2">
                                        <span>⚠️</span> Você está editando seus dados. As alterações serão registradas no histórico.
                                      </p>
                                    </div>
                                  )}
                                  
                                  <div><label className="block text-sm font-semibold mb-1">Nome Completo</label><input type="text" value={formData.finName ?? financialData?.full_name ?? ''} onChange={e => setFormData({...formData, finName: e.target.value})} className="w-full px-4 py-2 border rounded-lg" placeholder="Seu nome completo" /></div>
                                  <div><label className="block text-sm font-semibold mb-1">CPF</label><input type="text" value={formData.finCpf ?? financialData?.cpf ?? ''} onChange={e => setFormData({...formData, finCpf: formatCPF(e.target.value)})} className="w-full px-4 py-2 border rounded-lg" placeholder="000.000.000-00" maxLength={14} /></div>
                                  
                                  {/* Tipo da Chave PIX */}
                                  <div>
                                    <label className="block text-sm font-semibold mb-2">Tipo da Chave PIX</label>
                                    <div className="grid grid-cols-5 gap-2">
                                      {[
                                        { id: 'cpf', label: 'CPF', icon: '🪪' },
                                        { id: 'cnpj', label: 'CNPJ', icon: '🏢' },
                                        { id: 'telefone', label: 'Telefone', icon: '📱' },
                                        { id: 'email', label: 'Email', icon: '📧' },
                                        { id: 'aleatoria', label: 'Aleatória', icon: '🔑' }
                                      ].map(tipo => (
                                        <button
                                          key={tipo.id}
                                          type="button"
                                          onClick={() => setFormData({...formData, pixTipo: tipo.id, finPix: ''})}
                                          className={`p-2 rounded-lg border-2 text-center transition-all ${
                                            formData.pixTipo === tipo.id 
                                              ? 'border-blue-500 bg-blue-50 text-blue-700' 
                                              : 'border-gray-200 hover:border-gray-300'
                                          }`}
                                        >
                                          <span className="text-xl">{tipo.icon}</span>
                                          <p className="text-xs font-semibold mt-1">{tipo.label}</p>
                                        </button>
                                      ))}
                                    </div>
                                  </div>
                                  
                                  {/* Campo da Chave PIX */}
                                  <div>
                                    <label className="block text-sm font-semibold mb-1">Chave PIX</label>
                                    <input 
                                      type={formData.pixTipo === 'email' ? 'email' : 'text'}
                                      value={formData.finPix ?? financialData?.pix_key ?? ''} 
                                      onChange={e => setFormData({
                                        ...formData, 
                                        finPix: formatarChavePix(e.target.value, formData.pixTipo)
                                      })} 
                                      placeholder={getPixPlaceholder(formData.pixTipo)}
                                      disabled={!formData.pixTipo}
                                      maxLength={formData.pixTipo === 'cpf' ? 14 : formData.pixTipo === 'cnpj' ? 18 : formData.pixTipo === 'telefone' ? 15 : 100}
                                      className={`w-full px-4 py-2 border rounded-lg transition-all ${
                                        !formData.pixTipo 
                                          ? 'bg-gray-100 cursor-not-allowed' 
                                          : formData.finPix
                                            ? validarChavePix(formData.finPix, formData.pixTipo).valido 
                                              ? 'border-green-500 bg-green-50' 
                                              : 'border-red-500 bg-red-50'
                                            : ''
                                      }`}
                                    />
                                    {formData.finPix && formData.pixTipo && (
                                      <p className={`mt-1 text-sm ${
                                        validarChavePix(formData.finPix, formData.pixTipo).valido 
                                          ? 'text-green-600' 
                                          : 'text-red-600'
                                      }`}>
                                        {validarChavePix(formData.finPix, formData.pixTipo).mensagem}
                                      </p>
                                    )}
                                    {!formData.pixTipo && (
                                      <p className="mt-1 text-sm text-gray-500">👆 Selecione o tipo da chave acima</p>
                                    )}
                                  </div>
                                  
                                  <div className="flex gap-2">
                                    {editandoDados && (
                                      <button 
                                        onClick={() => {
                                          setEditandoDados(false);
                                          // Restaurar dados originais
                                          setFormData(prev => ({
                                            ...prev,
                                            finName: financialData?.full_name || '',
                                            finCpf: financialData?.cpf || '',
                                            finPix: financialData?.pix_key || '',
                                            pixTipo: financialData?.pix_tipo || ''
                                          }));
                                        }}
                                        className="flex-1 bg-gray-200 text-gray-700 py-3 rounded-lg font-bold hover:bg-gray-300 transition"
                                      >
                                        ✕ Cancelar
                                      </button>
                                    )}
                                    <button 
                                      onClick={handleSaveFinancial} 
                                      disabled={loading || !formData.pixTipo} 
                                      className={`${editandoDados ? 'flex-1' : 'w-full'} bg-blue-600 text-white py-3 rounded-lg font-bold disabled:opacity-50 disabled:cursor-not-allowed hover:bg-blue-700 transition`}
                                    >
                                      {loading ? '...' : '💾 Salvar Dados'}
                                    </button>
                                  </div>
                                </>
                              )}
                            </div>
                          )}
                          {formData.saqueTab === 'gratuidades' && (
                            <>
                              <h3 className="font-semibold mb-4">🎁 Minhas Gratuidades</h3>
                              {userGratuities.length === 0 ? <p className="text-gray-500">Nenhuma</p> : (
                                <div className="space-y-3">
                                  {userGratuities.map(g => (
                                    <div key={g.id} className={`border rounded-lg p-4 ${g.status === 'ativa' ? 'border-green-300 bg-green-50' : 'bg-gray-50'}`}>
                                      <div className="flex justify-between">
                                        <div><p className="font-bold">{g.remaining}/{g.quantity} restantes</p><p className="text-sm text-gray-600">Valor: {formatMoney(g.value)}</p></div>
                                        <span className={`px-3 py-1 rounded-full text-xs font-bold h-fit ${g.status === 'ativa' ? 'bg-green-500 text-white' : 'bg-gray-400 text-white'}`}>{g.status}</span>
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </>
                          )}
                        </div>
                      </div>
                    </>
                  )}
                    </>
                  )}
                </>
              )}

              {/* ========== ABA INDICAÇÕES ========== */}
              {formData.userTab === 'indicacoes' && (
                <>
                  {/* Modal para fazer indicação */}
                  {formData.modalIndicacao && (
                    <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4">
                      <div className="bg-white rounded-xl shadow-2xl p-6 max-w-md w-full">
                        <h3 className="text-xl font-bold text-blue-700 mb-4">👥 Fazer Indicação</h3>
                        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-4">
                          <p className="text-sm font-semibold text-blue-800">📍 {formData.modalIndicacao.regiao}</p>
                          <p className="text-2xl font-bold text-green-600">Bônus: {formatMoney(formData.modalIndicacao.valor_bonus)}</p>
                        </div>
                        <div className="space-y-4">
                          <div>
                            <label className="block text-sm font-semibold mb-1">Nome Completo do Indicado *</label>
                            <input 
                              type="text" 
                              value={formData.indicadoNome || ''} 
                              onChange={e => setFormData({...formData, indicadoNome: e.target.value})} 
                              className="w-full px-4 py-2 border rounded-lg"
                              placeholder="Nome completo"
                            />
                          </div>
                          <div>
                            <label className="block text-sm font-semibold mb-1">CPF (opcional)</label>
                            <input 
                              type="text" 
                              value={formData.indicadoCpf || ''} 
                              onChange={e => setFormData({...formData, indicadoCpf: formatCPF(e.target.value)})} 
                              className="w-full px-4 py-2 border rounded-lg"
                              placeholder="000.000.000-00"
                            />
                          </div>
                          <div>
                            <label className="block text-sm font-semibold mb-1">Contato (WhatsApp) *</label>
                            <input 
                              type="text" 
                              value={formData.indicadoContato || ''} 
                              onChange={e => setFormData({...formData, indicadoContato: formatTelefone(e.target.value)})} 
                              className={`w-full px-4 py-2 border rounded-lg ${formData.indicadoContato && !validarTelefone(formData.indicadoContato) ? 'border-red-500 bg-red-50' : ''}`}
                              placeholder="(62) 99390-8345"
                            />
                            {formData.indicadoContato && !validarTelefone(formData.indicadoContato) && (
                              <p className="text-red-500 text-xs mt-1">⚠️ Formato inválido. Use: (DD) 99999-9999</p>
                            )}
                          </div>
                        </div>
                        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3 mt-4">
                          <p className="text-xs text-yellow-800">⏰ A indicação será válida por <strong>30 dias</strong>. Se não for aprovada nesse período, irá expirar automaticamente.</p>
                        </div>
                        <div className="flex gap-3 mt-4">
                          <button onClick={() => setFormData({...formData, modalIndicacao: null, indicadoNome: '', indicadoCpf: '', indicadoContato: ''})} className="flex-1 px-4 py-2 bg-gray-200 text-gray-700 rounded-lg font-semibold hover:bg-gray-300">Cancelar</button>
                          <button onClick={() => handleEnviarIndicacao(formData.modalIndicacao)} disabled={loading} className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700 disabled:opacity-50">
                            {loading ? '...' : '📤 Enviar Indicação'}
                          </button>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Promoções Disponíveis */}
                  <div className="bg-white rounded-xl shadow p-6 mb-6">
                    <h2 className="text-xl font-bold text-blue-800 mb-4">🎯 Promoções de Indicação Disponíveis</h2>
                    {promocoes.length === 0 ? (
                      <div className="text-center py-8 text-gray-500">
                        <p className="text-4xl mb-2">📢</p>
                        <p>Nenhuma promoção disponível no momento</p>
                        <p className="text-sm">Fique atento, novas promoções podem aparecer a qualquer momento!</p>
                      </div>
                    ) : (
                      <div className="grid md:grid-cols-2 gap-4">
                        {promocoes.map(p => (
                          <div key={p.id} className="border-2 border-blue-200 bg-gradient-to-br from-blue-50 to-white rounded-xl p-6">
                            <div className="flex justify-between items-start mb-3">
                              <span className="px-3 py-1 bg-green-500 text-white rounded-full text-xs font-bold">🔥 ATIVA</span>
                            </div>
                            <p className="text-lg font-bold text-gray-800 mb-1">📍 {p.regiao}</p>
                            <p className="text-3xl font-bold text-green-600 mb-3">{formatMoney(p.valor_bonus)}</p>
                            {p.detalhes ? (
                              <div className="bg-white border border-blue-200 rounded-lg p-3 mb-4">
                                <p className="text-sm text-gray-700 whitespace-pre-wrap">{p.detalhes}</p>
                              </div>
                            ) : (
                              <p className="text-sm text-gray-600 mb-4">Indique um amigo para trabalhar nesta região e ganhe este bônus quando ele for aprovado!</p>
                            )}
                            <button 
                              onClick={() => setFormData({...formData, modalIndicacao: p})} 
                              className="w-full px-4 py-3 bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700"
                            >
                              👥 Fazer Indicação
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Minhas Indicações */}
                  <div className="bg-white rounded-xl shadow p-6">
                    <h2 className="text-lg font-bold text-gray-800 mb-4">📋 Minhas Indicações</h2>
                    {minhasIndicacoes.length === 0 ? (
                      <div className="text-center py-8 text-gray-500">
                        <p className="text-4xl mb-2">👥</p>
                        <p>Você ainda não fez nenhuma indicação</p>
                      </div>
                    ) : (
                      <div className="space-y-4">
                        {minhasIndicacoes.map(ind => {
                          const diasRestantes = Math.ceil((new Date(ind.expires_at) - new Date()) / (1000 * 60 * 60 * 24));
                          return (
                            <div key={ind.id} className={`border rounded-xl p-4 ${
                              ind.status === 'aprovada' ? 'border-green-300 bg-green-50' :
                              ind.status === 'rejeitada' ? 'border-red-300 bg-red-50' :
                              ind.status === 'expirada' ? 'border-gray-300 bg-gray-50' :
                              'border-yellow-300 bg-yellow-50'
                            }`}>
                              <div className="flex justify-between items-start">
                                <div>
                                  <p className="font-bold text-lg">{ind.indicado_nome}</p>
                                  <p className="text-sm text-gray-600">📍 {ind.regiao}</p>
                                  <p className="text-sm text-gray-600">📞 {ind.indicado_contato}</p>
                                  <p className="text-xs text-gray-500 mt-1">Enviado em {new Date(ind.created_at).toLocaleDateString('pt-BR')}</p>
                                </div>
                                <div className="text-right">
                                  <p className="text-xl font-bold text-green-600">{formatMoney(ind.valor_bonus)}</p>
                                  <span className={`inline-block mt-2 px-3 py-1 rounded-full text-xs font-bold ${
                                    ind.status === 'pendente' ? 'bg-yellow-500 text-white' :
                                    ind.status === 'aprovada' ? 'bg-green-500 text-white' :
                                    ind.status === 'rejeitada' ? 'bg-red-500 text-white' :
                                    'bg-gray-500 text-white'
                                  }`}>
                                    {ind.status === 'pendente' ? `⏳ Pendente (${diasRestantes > 0 ? diasRestantes + ' dias' : 'Expirando'})` :
                                     ind.status === 'aprovada' ? '✅ Aprovada' :
                                     ind.status === 'rejeitada' ? '❌ Rejeitada' :
                                     '⏰ Expirada'}
                                  </span>
                                </div>
                              </div>
                              {ind.status === 'aprovada' && (
                                <div className="mt-3 bg-green-100 border border-green-300 rounded-lg p-3">
                                  <p className="text-green-800 text-sm">🎉 <strong>Parabéns!</strong> Sua indicação foi aprovada! O bônus de {formatMoney(ind.valor_bonus)} será incluído no seu próximo repasse.</p>
                                </div>
                              )}
                              {ind.status === 'rejeitada' && ind.motivo_rejeicao && (
                                <div className="mt-3 bg-red-100 border border-red-300 rounded-lg p-3">
                                  <p className="text-red-800 text-sm"><strong>Motivo:</strong> {ind.motivo_rejeicao}</p>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </>
              )}

              {/* ========== ABA PROMOÇÕES NOVATOS (USUÁRIO) ========== */}
              {formData.userTab === 'promo-novatos' && (
                <>
                  {/* ========== QUIZ DE PROCEDIMENTOS (USUÁRIO) ========== */}
                  {quizConfig.ativo && !quizJaRespondeu && quizEtapa === 0 && (
                    <div className="bg-gradient-to-r from-purple-600 to-purple-800 rounded-xl shadow-lg p-6 mb-6 text-white">
                      <div className="text-center">
                        <div className="text-5xl mb-4">🎯</div>
                        <h2 className="text-xl font-bold mb-2">{quizConfig.titulo}</h2>
                        <p className="text-purple-200 mb-4">Responda corretamente e ganhe gratuidade no seu próximo saque!</p>
                        <div className="bg-white/20 rounded-lg p-4 mb-4">
                          <p className="text-2xl font-bold text-yellow-300">💰 R$ {quizConfig.valor_gratuidade.toFixed(2).replace('.', ',')}</p>
                          <p className="text-sm text-purple-200">de gratuidade se acertar tudo!</p>
                        </div>
                        <button 
                          onClick={() => { setQuizEtapa(1); setQuizCarrosselIndex(0); }}
                          className="px-8 py-3 bg-yellow-400 text-purple-900 rounded-lg font-bold text-lg hover:bg-yellow-300"
                        >
                          🚀 Começar Quiz!
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Quiz - Etapa 1: Carrossel de Imagens */}
                  {quizEtapa === 1 && (
                    <div className="bg-white rounded-xl shadow-lg p-6 mb-6">
                      <div className="text-center mb-4">
                        <h2 className="text-xl font-bold text-purple-700">📸 Conheça os Procedimentos</h2>
                        <p className="text-gray-500 text-sm">Veja as imagens com atenção antes de responder</p>
                        <p className="text-purple-600 font-semibold mt-2">Imagem {quizCarrosselIndex + 1} de 4</p>
                      </div>
                      
                      {/* Carrossel */}
                      <div className="relative bg-gray-100 rounded-xl overflow-hidden mb-4" style={{minHeight: '300px'}}>
                        {quizConfig.imagens[quizCarrosselIndex] ? (
                          <img 
                            src={quizConfig.imagens[quizCarrosselIndex]} 
                            alt={`Procedimento ${quizCarrosselIndex + 1}`}
                            className="w-full h-full object-contain"
                            style={{maxHeight: '400px'}}
                          />
                        ) : (
                          <div className="flex items-center justify-center h-64 text-gray-400">
                            <p>Imagem não disponível</p>
                          </div>
                        )}
                      </div>
                      
                      {/* Indicadores */}
                      <div className="flex justify-center gap-2 mb-4">
                        {[0, 1, 2, 3].map(i => (
                          <button 
                            key={i}
                            onClick={() => setQuizCarrosselIndex(i)}
                            className={`w-3 h-3 rounded-full transition ${quizCarrosselIndex === i ? 'bg-purple-600' : 'bg-gray-300'}`}
                          />
                        ))}
                      </div>
                      
                      {/* Navegação */}
                      <div className="flex justify-between">
                        <button 
                          onClick={() => setQuizCarrosselIndex(Math.max(0, quizCarrosselIndex - 1))}
                          disabled={quizCarrosselIndex === 0}
                          className="px-6 py-2 bg-gray-200 text-gray-700 rounded-lg font-semibold disabled:opacity-50"
                        >
                          ← Anterior
                        </button>
                        {quizCarrosselIndex < 3 ? (
                          <button 
                            onClick={() => setQuizCarrosselIndex(quizCarrosselIndex + 1)}
                            className="px-6 py-2 bg-purple-600 text-white rounded-lg font-semibold hover:bg-purple-700"
                          >
                            Próxima →
                          </button>
                        ) : (
                          <button 
                            onClick={() => setQuizEtapa(2)}
                            className="px-6 py-2 bg-green-600 text-white rounded-lg font-bold hover:bg-green-700"
                          >
                            ✅ Ir para o Quiz!
                          </button>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Quiz - Etapa 2: Perguntas */}
                  {quizEtapa === 2 && (
                    <div className="bg-white rounded-xl shadow-lg p-6 mb-6">
                      <div className="text-center mb-6">
                        <h2 className="text-xl font-bold text-purple-700">❓ Responda: CERTO ou ERRADO?</h2>
                        <p className="text-gray-500 text-sm">Acerte as 5 afirmações para ganhar a gratuidade</p>
                      </div>
                      
                      <div className="space-y-4 mb-6">
                        {quizConfig.perguntas.map((p, i) => (
                          <div key={i} className={`border-2 rounded-xl p-4 transition ${
                            quizRespostasUsuario[i] !== null 
                              ? 'border-purple-300 bg-purple-50' 
                              : 'border-gray-200'
                          }`}>
                            <p className="font-semibold text-gray-800 mb-3">
                              <span className="text-purple-600">{i + 1}.</span> {p.texto}
                            </p>
                            <div className="flex gap-3">
                              <button 
                                onClick={() => {
                                  const novas = [...quizRespostasUsuario];
                                  novas[i] = true;
                                  setQuizRespostasUsuario(novas);
                                }}
                                className={`flex-1 py-3 rounded-lg font-bold text-lg transition ${
                                  quizRespostasUsuario[i] === true 
                                    ? 'bg-green-500 text-white' 
                                    : 'bg-green-100 text-green-700 hover:bg-green-200'
                                }`}
                              >
                                ✓ CERTO
                              </button>
                              <button 
                                onClick={() => {
                                  const novas = [...quizRespostasUsuario];
                                  novas[i] = false;
                                  setQuizRespostasUsuario(novas);
                                }}
                                className={`flex-1 py-3 rounded-lg font-bold text-lg transition ${
                                  quizRespostasUsuario[i] === false 
                                    ? 'bg-red-500 text-white' 
                                    : 'bg-red-100 text-red-700 hover:bg-red-200'
                                }`}
                              >
                                ✗ ERRADO
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                      
                      <div className="flex gap-3">
                        <button 
                          onClick={() => setQuizEtapa(1)}
                          className="px-6 py-3 bg-gray-200 text-gray-700 rounded-lg font-semibold"
                        >
                          ← Voltar às imagens
                        </button>
                        <button 
                          onClick={handleResponderQuiz}
                          disabled={loading || quizRespostasUsuario.some(r => r === null)}
                          className="flex-1 py-3 bg-purple-600 text-white rounded-lg font-bold text-lg hover:bg-purple-700 disabled:opacity-50"
                        >
                          {loading ? 'Enviando...' : '🎯 Enviar Respostas'}
                        </button>
                      </div>
                      
                      <p className="text-center text-xs text-gray-500 mt-3">
                        ⚠️ Você tem apenas UMA chance de responder este quiz!
                      </p>
                    </div>
                  )}

                  {/* Quiz - Etapa 3: Resultado */}
                  {quizEtapa === 3 && quizResultado && (
                    <div className={`rounded-xl shadow-lg p-6 mb-6 text-center ${quizResultado.passou ? 'bg-green-500' : 'bg-red-500'} text-white`}>
                      <div className="text-6xl mb-4">{quizResultado.passou ? '🎉' : '😢'}</div>
                      <h2 className="text-2xl font-bold mb-2">
                        {quizResultado.passou ? 'Parabéns! Você passou!' : 'Que pena! Não foi dessa vez...'}
                      </h2>
                      <p className="text-lg mb-4">
                        Você acertou <strong>{quizResultado.acertos}</strong> de <strong>5</strong> perguntas
                      </p>
                      {quizResultado.passou && (
                        <div className="bg-white/20 rounded-lg p-4 mb-4">
                          <p className="text-xl font-bold">💰 R$ {quizResultado.valor_gratuidade.toFixed(2).replace('.', ',')}</p>
                          <p className="text-sm">foi adicionado às suas gratuidades!</p>
                        </div>
                      )}
                      <button 
                        onClick={() => setQuizEtapa(0)}
                        className="px-6 py-2 bg-white text-gray-800 rounded-lg font-semibold"
                      >
                        Fechar
                      </button>
                    </div>
                  )}

                  {/* Mensagem se já respondeu */}
                  {quizConfig.ativo && quizJaRespondeu && quizEtapa === 0 && (
                    <div className="bg-gray-100 border-2 border-gray-300 rounded-xl p-6 mb-6 text-center">
                      <div className="text-4xl mb-2">✅</div>
                      <p className="text-gray-600 font-semibold">Você já participou do Quiz de Procedimentos</p>
                      <p className="text-gray-500 text-sm">Esta promoção só pode ser usada uma vez</p>
                    </div>
                  )}

                  <hr className="my-6 border-gray-200" />

                  {/* Promoções Disponíveis */}
                  <div className="bg-white rounded-xl shadow p-6 mb-6">
                    <h2 className="text-lg font-bold text-orange-700 mb-4">🚀 Promoções Disponíveis para Novatos</h2>
                    {promocoesNovatos.length === 0 ? (
                      <div className="text-center py-8">
                        <p className="text-6xl mb-4">😕</p>
                        <p className="text-gray-500 font-semibold">Nenhuma promoção disponível no momento</p>
                        <p className="text-gray-400 text-sm">Volte mais tarde para verificar novas promoções</p>
                      </div>
                    ) : (
                      <div className="grid md:grid-cols-2 gap-4">
                        {promocoesNovatos.map(promo => {
                          const jaInscrito = minhasInscricoesNovatos.some(i => i.promocao_id === promo.id);
                          return (
                            <div key={promo.id} className="border-2 border-orange-200 bg-orange-50 rounded-xl p-4">
                              <div className="flex justify-between items-start mb-2">
                                <div>
                                  <p className="text-sm text-gray-600">📍 {promo.regiao}</p>
                                  <p className="font-bold text-lg text-gray-800">🏢 {promo.cliente}</p>
                                </div>
                                <span className="px-3 py-1 bg-green-500 text-white rounded-full text-sm font-bold">
                                  {formatMoney(promo.valor_bonus)}
                                </span>
                              </div>
                              {promo.detalhes && (
                                <p className="text-sm text-gray-600 mb-3 whitespace-pre-wrap">{promo.detalhes}</p>
                              )}
                              <div className="bg-yellow-100 border border-yellow-300 rounded-lg p-2 mb-3">
                                <p className="text-xs text-yellow-800">⏱️ Ao se inscrever, você terá <strong>10 dias</strong> para ser contemplado</p>
                              </div>
                              {jaInscrito ? (
                                <button disabled className="w-full py-2 bg-gray-300 text-gray-600 rounded-lg font-semibold cursor-not-allowed">
                                  ✅ Já inscrito
                                </button>
                              ) : (
                                <button 
                                  onClick={() => handleInscreverNovatos(promo)}
                                  disabled={loading}
                                  className="w-full py-2 bg-orange-500 text-white rounded-lg font-semibold hover:bg-orange-600 disabled:opacity-50"
                                >
                                  {loading ? '...' : '🚀 Quero me inscrever!'}
                                </button>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {/* Minhas Inscrições */}
                  <div className="bg-white rounded-xl shadow p-6">
                    <h2 className="text-lg font-bold text-gray-800 mb-4">📋 Minhas Inscrições e Bonificações</h2>
                    
                    {/* Resultado do Quiz de Procedimentos */}
                    {quizDadosUsuario && (
                      <div className={`border-2 rounded-xl p-4 mb-4 ${quizDadosUsuario.passou ? 'border-green-400 bg-green-50' : 'border-red-300 bg-red-50'}`}>
                        <div className="flex justify-between items-start">
                          <div className="flex items-center gap-3">
                            <span className="text-3xl">{quizDadosUsuario.passou ? '🎉' : '📝'}</span>
                            <div>
                              <p className="font-bold text-gray-800">Quiz de Procedimentos</p>
                              <p className="text-sm text-gray-600">Respondido em: {new Date(quizDadosUsuario.created_at).toLocaleDateString('pt-BR')}</p>
                              <p className="text-sm text-gray-500">Acertos: {quizDadosUsuario.acertos}/5</p>
                            </div>
                          </div>
                          <div className="text-right">
                            {quizDadosUsuario.passou && (
                              <p className="font-bold text-green-600 text-lg">{formatMoney(quizConfig.valor_gratuidade)}</p>
                            )}
                            <span className={`inline-block mt-1 px-3 py-1 rounded-full text-xs font-bold ${quizDadosUsuario.passou ? 'bg-green-500 text-white' : 'bg-red-400 text-white'}`}>
                              {quizDadosUsuario.passou ? '✅ Aprovado' : '❌ Não passou'}
                            </span>
                          </div>
                        </div>
                        {quizDadosUsuario.passou && (
                          <div className="mt-3 bg-green-100 border border-green-300 rounded-lg p-3">
                            <p className="text-green-800 text-sm">🎉 <strong>Parabéns!</strong> Você acertou todas as perguntas! A gratuidade de {formatMoney(quizConfig.valor_gratuidade)} foi adicionada à sua conta.</p>
                          </div>
                        )}
                        {!quizDadosUsuario.passou && (
                          <div className="mt-3 bg-red-100 border border-red-300 rounded-lg p-3">
                            <p className="text-red-800 text-sm">😢 Infelizmente você não acertou todas as perguntas. Era necessário acertar 5/5 para ganhar a gratuidade.</p>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Inscrições em Promoções por Cliente */}
                    {minhasInscricoesNovatos.length === 0 && !quizDadosUsuario ? (
                      <p className="text-gray-500 text-center py-4">Você ainda não participou de nenhuma promoção</p>
                    ) : (
                      <div className="space-y-3">
                        {minhasInscricoesNovatos.map(ins => {
                          const dataExpira = ins.expires_at ? new Date(ins.expires_at) : null;
                          const expirado = dataExpira && new Date() > dataExpira;
                          return (
                            <div key={ins.id} className={`border rounded-lg p-4 ${
                              ins.status === 'aprovada' ? 'border-green-300 bg-green-50' :
                              ins.status === 'rejeitada' ? 'border-red-300 bg-red-50' :
                              expirado ? 'border-gray-300 bg-gray-50' :
                              'border-yellow-300 bg-yellow-50'
                            }`}>
                              <div className="flex justify-between items-start">
                                <div>
                                  <p className="font-semibold text-gray-800">🏢 {ins.cliente}</p>
                                  <p className="text-sm text-gray-600">📍 {ins.regiao}</p>
                                  <p className="text-sm text-gray-500">Inscrito em: {new Date(ins.created_at).toLocaleDateString('pt-BR')}</p>
                                  {dataExpira && ins.status === 'pendente' && !expirado && (
                                    <p className="text-xs text-orange-600">⏱️ Expira em: {dataExpira.toLocaleDateString('pt-BR')}</p>
                                  )}
                                </div>
                                <div className="text-right">
                                  <p className="font-bold text-green-600">{formatMoney(ins.valor_bonus)}</p>
                                  <span className={`inline-block mt-1 px-2 py-1 rounded-full text-xs font-bold ${
                                    ins.status === 'pendente' && !expirado ? 'bg-yellow-200 text-yellow-800' :
                                    ins.status === 'aprovada' ? 'bg-green-200 text-green-800' :
                                    ins.status === 'rejeitada' ? 'bg-red-200 text-red-800' :
                                    'bg-gray-200 text-gray-800'
                                  }`}>
                                    {ins.status === 'pendente' && expirado ? '⏰ Expirada' :
                                     ins.status === 'pendente' ? '⏳ Pendente' :
                                     ins.status === 'aprovada' ? '✅ Aprovada' :
                                     ins.status === 'rejeitada' ? '❌ Rejeitada' : ins.status}
                                  </span>
                                </div>
                              </div>
                              {ins.status === 'aprovada' && (
                                <div className="mt-3 bg-green-100 border border-green-300 rounded-lg p-3">
                                  <p className="text-green-800 text-sm">🎉 <strong>Parabéns!</strong> Você foi contemplado! O bônus de {formatMoney(ins.valor_bonus)} será incluído no seu próximo repasse.</p>
                                </div>
                              )}
                              {ins.status === 'rejeitada' && ins.motivo_rejeicao && (
                                <div className="mt-3 bg-red-100 border border-red-300 rounded-lg p-3">
                                  <p className="text-red-800 text-sm"><strong>Motivo:</strong> {ins.motivo_rejeicao}</p>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </>
              )}

              {/* ABA SEGURO DE VIDA IZA */}
              {formData.userTab === 'seguro-iza' && (
                <div className="max-w-lg mx-auto">
                  {/* Card Principal com visual similar à imagem */}
                  <div className="bg-gradient-to-b from-sky-100 to-white rounded-2xl shadow-xl overflow-hidden">
                    
                    {/* Header */}
                    <div className="bg-gradient-to-r from-blue-600 to-blue-700 text-white text-center py-4 px-4">
                      <h2 className="text-xl font-bold tracking-wide">🛡️ SEGURO DE VIDA PARA</h2>
                      <h2 className="text-xl font-bold tracking-wide">ENTREGADORES TUTTS</h2>
                    </div>

                    <div className="p-4 space-y-4">
                      
                      {/* Quando está ativo */}
                      <div className="bg-white rounded-xl shadow border-l-4 border-yellow-400 overflow-hidden">
                        <div className="bg-yellow-400 text-yellow-900 font-bold text-center py-2 text-sm italic">
                          QUANDO ESTÁ ATIVO?
                        </div>
                        <div className="p-4 space-y-2 text-sm text-gray-700">
                          <p>🕐 Durante a entrega (aceite à finalização)</p>
                          <p>⏳ <strong>Limite:</strong> 60 min por entrega (encerra após)</p>
                          <p>❌ <strong>Não cobre:</strong> Trajeto casa/pessoal</p>
                        </div>
                      </div>

                      {/* Coberturas e Valores */}
                      <div className="bg-white rounded-xl shadow border-l-4 border-green-500 overflow-hidden">
                        <div className="bg-green-500 text-white font-bold text-center py-2 text-sm">
                          COBERTURAS E VALORES
                        </div>
                        <div className="p-4 space-y-2 text-sm text-gray-700">
                          <p>☠️ <strong>Morte Acidental:</strong> R$ 20.000</p>
                          <p>💰 <strong>Invalidez Perm.:</strong> R$ 20.000</p>
                          <p>🏥 <strong>Desp. Médicas/Hosp.:</strong> Até R$ 5.000</p>
                          <p>📅 <strong>Diária Incapacidade:</strong> R$ 80/dia (30 dias)</p>
                          <p>⚰️ <strong>Funeral:</strong> R$ 5.000</p>
                        </div>
                      </div>

                      {/* Quando NÃO cobre */}
                      <div className="bg-white rounded-xl shadow border-l-4 border-red-500 overflow-hidden">
                        <div className="bg-red-500 text-white font-bold text-center py-2 text-sm">
                          QUANDO NÃO COBRE?
                        </div>
                        <div className="p-4 space-y-2 text-sm text-gray-700">
                          <p>⚠️ Cadastro/CPF incorreto</p>
                          <p>⚠️ Sem CNH válida</p>
                          <p>⚠️ Veículo errado</p>
                          <p>⚠️ Fora de entrega ativa</p>
                          <p>⚠️ Fraude/Má-fé</p>
                        </div>
                      </div>

                      {/* Como Acionar */}
                      <div className="bg-white rounded-xl shadow border-l-4 border-gray-500 overflow-hidden">
                        <div className="bg-gray-600 text-white font-bold text-center py-2 text-sm">
                          COMO ACIONAR? (IZA Seguros)
                        </div>
                        <div className="p-4 space-y-2 text-sm text-gray-700">
                          <p>📱 <strong>Baixar</strong> App IZA</p>
                          <p>📋 <strong>Informar</strong> Data/Hora/Local</p>
                          <p>📄 <strong>Anexar Documentos</strong> (B.O., atestado)</p>
                          <p>📞 <strong>Suporte:</strong> Tel (11) 4673-2002</p>
                          <p>
                            💬 <strong>WhatsApp:</strong>{' '}
                            <a 
                              href="https://wa.me/551146732004" 
                              target="_blank" 
                              rel="noopener noreferrer"
                              className="text-green-600 font-bold underline hover:text-green-700"
                            >
                              (11) 4673-2004
                            </a>
                          </p>
                          <p>🌐 <strong>Site:</strong>{' '}
                            <a 
                              href="https://www.iza.com.vc" 
                              target="_blank" 
                              rel="noopener noreferrer"
                              className="text-blue-600 underline hover:text-blue-700"
                            >
                              www.iza.com.vc
                            </a>
                          </p>
                        </div>
                      </div>

                      {/* Outras Informações */}
                      <div className="bg-white rounded-xl shadow border-l-4 border-orange-400 overflow-hidden">
                        <div className="bg-orange-400 text-white font-bold text-center py-2 text-sm">
                          OUTRAS INFORMAÇÕES
                        </div>
                        <div className="p-4 space-y-2 text-sm text-gray-700">
                          <p>ℹ️ <strong>Sem carência</strong> (desde 1ª entrega)</p>
                          <p>ℹ️ <strong>Renova</strong> a cada entrega aceita</p>
                        </div>
                      </div>

                      {/* Botão Ver Mais Detalhes */}
                      <button 
                        onClick={() => setFormData({...formData, seguroDetalhes: !formData.seguroDetalhes})}
                        className="w-full py-3 bg-blue-600 text-white rounded-xl font-bold hover:bg-blue-700 transition-all flex items-center justify-center gap-2"
                      >
                        📄 {formData.seguroDetalhes ? 'Ocultar Detalhes' : 'Ver Texto com Mais Detalhes'}
                      </button>

                      {/* Texto Completo (expandível) */}
                      {formData.seguroDetalhes && (
                        <div className="bg-white rounded-xl shadow p-4 text-sm text-gray-700 space-y-4 border border-blue-200">
                          <h3 className="font-bold text-blue-800 text-lg">📋 Informações Completas do Seguro</h3>
                          
                          <div>
                            <h4 className="font-bold text-gray-800 mb-2">Quando o seguro está ativo?</h4>
                            <ul className="list-disc pl-5 space-y-1">
                              <li>O seguro cobre você durante o período em que estiver realizando uma entrega pela plataforma da Tutts.</li>
                              <li>A cobertura é ativada automaticamente desde o aceite da entrega até a finalização no destino.</li>
                              <li>Não cobre o trajeto de casa para o trabalho ou atividades pessoais.</li>
                              <li>O entregador estará coberto durante o período da entrega, limitado a até 60 minutos. Ou seja, se a entrega ultrapassar esse tempo e for finalizada após os 60 minutos, a cobertura do seguro de vida será encerrada.</li>
                            </ul>
                          </div>

                          <div>
                            <h4 className="font-bold text-gray-800 mb-2">Coberturas e Valores</h4>
                            <ul className="list-disc pl-5 space-y-1">
                              <li><strong>Morte Acidental:</strong> R$ 20.000,00</li>
                              <li><strong>Invalidez Permanente Total ou Parcial por Acidente:</strong> R$ 20.000,00</li>
                              <li><strong>Despesas Médicas, Hospitalares e Odontológicos:</strong> Até R$ 5.000,00</li>
                              <li><strong>Diária por Incapacidade Temporária (até 30 dias):</strong> R$ 80,00 por dia</li>
                              <li><strong>Funeral:</strong> R$ 5.000,00</li>
                            </ul>
                          </div>

                          <div>
                            <h4 className="font-bold text-gray-800 mb-2">Quando o seguro não cobre?</h4>
                            <ul className="list-disc pl-5 space-y-1">
                              <li>Se o entregador não estiver cadastrado corretamente ou com CPF incorreto.</li>
                              <li>Se estiver sem habilitação válida no momento do acidente.</li>
                              <li>Se estiver usando o veículo errado (ex.: moto em contrato de carro).</li>
                              <li>Se estiver fora de uma entrega ativa pela plataforma da Tutts.</li>
                              <li>Se for constatado fraude ou má-fé.</li>
                            </ul>
                          </div>

                          <div>
                            <h4 className="font-bold text-gray-800 mb-2">Como acionar o seguro em caso de acidente?</h4>
                            <ul className="list-disc pl-5 space-y-1">
                              <li>Baixe o aplicativo IZA Seguros.</li>
                              <li>Informe: data, horário e local do acidente.</li>
                              <li>Anexe os documentos solicitados no app (como boletim de ocorrência ou atestado médico).</li>
                              <li>
                                Dúvidas ou suporte: Telefone (11) 4673-2002 | WhatsApp{' '}
                                <a 
                                  href="https://wa.me/551146732004" 
                                  target="_blank" 
                                  rel="noopener noreferrer"
                                  className="text-green-600 font-bold underline"
                                >
                                  (11) 4673-2004
                                </a>
                              </li>
                              <li>
                                Site:{' '}
                                <a 
                                  href="https://www.iza.com.vc" 
                                  target="_blank" 
                                  rel="noopener noreferrer"
                                  className="text-blue-600 underline"
                                >
                                  www.iza.com.vc
                                </a>
                              </li>
                            </ul>
                          </div>

                          <div>
                            <h4 className="font-bold text-gray-800 mb-2">Outras Informações</h4>
                            <ul className="list-disc pl-5 space-y-1">
                              <li><strong>Sem carência:</strong> você estará coberto a partir da primeira entrega feita no dia.</li>
                              <li>A cobertura se renova a cada entrega aceita na plataforma da Tutts.</li>
                            </ul>
                          </div>
                        </div>
                      )}

                    </div>
                  </div>
                </div>
              )}
              </div>
            )}
          </div>
        );
      }


      // ========== PAINEL ADMIN FINANCEIRO ==========
      if (user.role === 'admin_financeiro' || (user.role === 'admin_master' && adminMasterModule === 'financeiro')) {
        const isAdminMaster = user.role === 'admin_master';
        return (
          <div className="min-h-screen bg-gray-50">
            {toast && <Toast {...toast} />}
            {globalLoading && <LoadingOverlay />}
            {pixQRModal && <PixQRCodeModal data={pixQRModal} onClose={() => setPixQRModal(null)} />}

            {isAdminMaster ? (
              /* Navbar Admin Master */
              <nav className="bg-gradient-to-r from-indigo-900 to-purple-900 shadow-lg">
                <div className="max-w-7xl mx-auto px-4 py-4 flex justify-between items-center">
                  <div className="flex items-center gap-4">
                    <div>
                      <h1 className="text-xl font-bold text-white">👑 Admin Master</h1>
                      <p className="text-xs text-indigo-200">{user.fullName}</p>
                    </div>
                    <div className="flex bg-white/10 rounded-lg p-1">
                      <button onClick={() => setAdminMasterModule('solicitacoes')} className={`px-4 py-2 rounded-lg text-sm font-semibold transition-all ${adminMasterModule === 'solicitacoes' ? 'bg-white text-purple-900' : 'text-white hover:bg-white/10'}`}>
                        📋 Solicitações
                      </button>
                      <button onClick={() => setAdminMasterModule('financeiro')} className={`px-4 py-2 rounded-lg text-sm font-semibold transition-all ${adminMasterModule === 'financeiro' ? 'bg-white text-green-800' : 'text-white hover:bg-white/10'}`}>
                        💰 Financeiro
                      </button>
                      <button onClick={() => setAdminMasterModule('disponibilidade')} className={`px-4 py-2 rounded-lg text-sm font-semibold transition-all ${adminMasterModule === 'disponibilidade' ? 'bg-white text-blue-800' : 'text-white hover:bg-white/10'}`}>
                        📅 Disponibilidade
                      </button>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="flex items-center gap-2 bg-white/10 px-3 py-1 rounded-full">
                      <span className={`w-2 h-2 rounded-full ${isPolling ? 'bg-yellow-400 animate-pulse' : 'bg-green-400'}`}></span>
                      <span className="text-xs text-indigo-200">{isPolling ? 'Atualizando...' : lastUpdate ? `${lastUpdate.toLocaleTimeString('pt-BR', {hour: '2-digit', minute: '2-digit'})}` : '60s'}</span>
                    </div>
                    <button onClick={refreshAll} className="px-4 py-2 bg-white/20 text-white rounded-lg hover:bg-white/30 text-sm font-semibold">🔄</button>
                    <button onClick={() => setUser(null)} className="px-4 py-2 text-white hover:bg-white/20 rounded-lg">Sair</button>
                  </div>
                </div>
              </nav>
            ) : (
              /* Navbar Admin Financeiro normal */
              <nav className="bg-green-800 shadow-lg">
                <div className="max-w-7xl mx-auto px-4 py-4 flex justify-between items-center">
                  <div className="flex items-center gap-3">
                    <h1 className="text-xl font-bold text-white">💰 Painel Financeiro</h1>
                    <div className="flex items-center gap-2 bg-green-900/50 px-3 py-1 rounded-full">
                      <span className={`w-2 h-2 rounded-full ${isPolling ? 'bg-yellow-400 animate-pulse' : 'bg-green-400'}`}></span>
                      <span className="text-xs text-green-200">{isPolling ? 'Atualizando...' : lastUpdate ? `Atualizado ${lastUpdate.toLocaleTimeString('pt-BR', {hour: '2-digit', minute: '2-digit'})}` : 'Auto-refresh: 60s'}</span>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button onClick={refreshAll} className="px-4 py-2 bg-green-700 text-white rounded-lg hover:bg-green-600 text-sm font-semibold">🔄</button>
                    <button onClick={() => setUser(null)} className="px-4 py-2 text-white hover:bg-green-700 rounded-lg">Sair</button>
                  </div>
                </div>
              </nav>
            )}

            {/* Modal de confirmação de exclusão */}
            {formData.deleteConfirm && (
              <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4">
                <div className="bg-white rounded-xl shadow-2xl p-6 max-w-md w-full">
                  <h3 className="text-xl font-bold text-red-600 mb-4">⚠️ Confirmar Exclusão</h3>
                  <p className="text-gray-700 mb-2">Tem certeza que deseja excluir esta solicitação?</p>
                  <div className="bg-gray-50 rounded-lg p-4 mb-4">
                    <p className="text-sm"><strong>Profissional:</strong> {formData.deleteConfirm.user_name}</p>
                    <p className="text-sm"><strong>Código:</strong> {formData.deleteConfirm.user_cod}</p>
                    <p className="text-sm"><strong>Valor:</strong> {formatMoney(formData.deleteConfirm.requested_amount)}</p>
                    <p className="text-sm"><strong>Data:</strong> {new Date(formData.deleteConfirm.created_at).toLocaleString('pt-BR')}</p>
                  </div>
                  <p className="text-red-600 text-sm mb-4 font-semibold">Esta ação não pode ser desfeita!</p>
                  <div className="flex gap-3">
                    <button onClick={() => setFormData({...formData, deleteConfirm: null})} className="flex-1 px-4 py-2 bg-gray-200 text-gray-700 rounded-lg font-semibold hover:bg-gray-300">Cancelar</button>
                    <button onClick={() => handleDeleteWithdrawal(formData.deleteConfirm.id)} className="flex-1 px-4 py-2 bg-red-600 text-white rounded-lg font-semibold hover:bg-red-700">🗑️ Excluir</button>
                  </div>
                </div>
              </div>
            )}

            <div className="bg-white border-b sticky top-0 z-10">
              <div className="max-w-7xl mx-auto px-2 flex gap-0.5 overflow-x-auto">
                {['solicitacoes', 'validacao', 'conciliacao', 'resumo', 'gratuidades', 'restritos', 'indicacoes', 'promo-novatos', 'relatorios', 'horarios', 'avisos', 'backup'].map(tab => (
                  <button key={tab} onClick={() => setFormData({...formData, finTab: tab})} className={`px-2 py-1.5 text-xs font-semibold whitespace-nowrap rounded-t-lg ${(formData.finTab || 'solicitacoes') === tab ? 'text-green-700 border-b-2 border-green-600 bg-green-50' : 'text-gray-600 hover:bg-gray-100'}`}>
                    {tab === 'solicitacoes' && '📋 Solicitações'}
                    {tab === 'validacao' && '📊 Validação'}
                    {tab === 'conciliacao' && '✅ Conciliação'}
                    {tab === 'resumo' && '🔍 Resumo'}
                    {tab === 'gratuidades' && '🎁 Gratuidades'}
                    {tab === 'restritos' && '🚫 Restritos'}
                    {tab === 'indicacoes' && '👥 Indicações'}
                    {tab === 'promo-novatos' && '🚀 Promo Novatos'}
                    {tab === 'relatorios' && '📈 Relatórios'}
                    {tab === 'horarios' && '🕐 Horários'}
                    {tab === 'avisos' && '📢 Avisos'}
                    {tab === 'backup' && '💾 Backup'}
                  </button>
                ))}
              </div>
            </div>

            <div className="max-w-7xl mx-auto p-6">
              {(!formData.finTab || formData.finTab === 'solicitacoes') && (
                <>
                  {/* Cards de estatísticas */}
                  <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
                    <div className="bg-white rounded-xl shadow p-4">
                      <p className="text-sm text-gray-600">Total</p>
                      <p className="text-2xl font-bold text-purple-600">{allWithdrawals.length}</p>
                    </div>
                    <div className="bg-white rounded-xl shadow p-4">
                      <p className="text-sm text-gray-600">Aguardando</p>
                      <p className="text-2xl font-bold text-yellow-600">{allWithdrawals.filter(w => w.status === 'aguardando_aprovacao').length}</p>
                    </div>
                    <div className="bg-white rounded-xl shadow p-4">
                      <p className="text-sm text-gray-600">Aprovadas</p>
                      <p className="text-2xl font-bold text-green-600">{allWithdrawals.filter(w => w.status === 'aprovado').length}</p>
                    </div>
                    <div className="bg-white rounded-xl shadow p-4">
                      <p className="text-sm text-gray-600">Aprov. Gratuidade</p>
                      <p className="text-2xl font-bold text-emerald-600">{allWithdrawals.filter(w => w.status === 'aprovado_gratuidade').length}</p>
                    </div>
                    <div className="bg-white rounded-xl shadow p-4">
                      <p className="text-sm text-gray-600">Rejeitadas</p>
                      <p className="text-2xl font-bold text-red-600">{allWithdrawals.filter(w => w.status === 'rejeitado').length}</p>
                    </div>
                  </div>

                  {/* Alerta de Saques Atrasados */}
                  {(() => {
                    const saquesAtrasados = allWithdrawals.filter(w => {
                      if (w.status !== 'aguardando_aprovacao') return false;
                      const horasSolicitacao = (Date.now() - new Date(w.created_at).getTime()) / (1000 * 60 * 60);
                      return horasSolicitacao >= 1;
                    });
                    
                    if (saquesAtrasados.length === 0) return null;
                    
                    return (
                      <div className="bg-red-50 border-2 border-red-400 rounded-xl p-4 mb-6 animate-pulse">
                        <div className="flex items-center gap-3">
                          <span className="text-3xl">🚨</span>
                          <div className="flex-1">
                            <p className="text-red-800 font-bold text-lg">ATENÇÃO: {saquesAtrasados.length} saque(s) aguardando há mais de 1 hora!</p>
                            <p className="text-red-600 text-sm mt-1">Profissionais aguardando: {saquesAtrasados.map(w => w.user_name || w.user_cod).join(', ')}</p>
                          </div>
                          <button 
                            onClick={() => setFormData({...formData, filterStatus: 'atrasados'})} 
                            className="px-4 py-2 bg-red-600 text-white rounded-lg font-semibold hover:bg-red-700 whitespace-nowrap"
                          >
                            👀 Ver Atrasados
                          </button>
                        </div>
                      </div>
                    );
                  })()}

                  <div className="bg-white rounded-xl shadow overflow-hidden">
                    {/* Botões de filtro */}
                    <div className="p-4 border-b">
                      <div className="flex flex-wrap gap-2">
                        <button onClick={() => setFormData({...formData, filterStatus: ''})} className={`px-4 py-2 rounded-lg font-semibold text-sm ${!formData.filterStatus ? 'bg-purple-600 text-white' : 'bg-gray-100 hover:bg-gray-200'}`}>
                          📋 Todas ({allWithdrawals.length})
                        </button>
                        <button onClick={() => setFormData({...formData, filterStatus: 'atrasados'})} className={`px-4 py-2 rounded-lg font-semibold text-sm ${formData.filterStatus === 'atrasados' ? 'bg-red-600 text-white' : 'bg-gray-100 hover:bg-gray-200'}`}>
                          🚨 Atrasados ({allWithdrawals.filter(w => w.status === 'aguardando_aprovacao' && (Date.now() - new Date(w.created_at).getTime()) >= 3600000).length})
                        </button>
                        <button onClick={() => setFormData({...formData, filterStatus: 'aguardando_aprovacao'})} className={`px-4 py-2 rounded-lg font-semibold text-sm ${formData.filterStatus === 'aguardando_aprovacao' ? 'bg-yellow-500 text-white' : 'bg-gray-100 hover:bg-gray-200'}`}>
                          ⏳ Aguardando ({allWithdrawals.filter(w => w.status === 'aguardando_aprovacao').length})
                        </button>
                        <button onClick={() => setFormData({...formData, filterStatus: 'aprovado'})} className={`px-4 py-2 rounded-lg font-semibold text-sm ${formData.filterStatus === 'aprovado' ? 'bg-green-600 text-white' : 'bg-gray-100 hover:bg-gray-200'}`}>
                          ✅ Aprovadas ({allWithdrawals.filter(w => w.status === 'aprovado').length})
                        </button>
                        <button onClick={() => setFormData({...formData, filterStatus: 'aprovado_gratuidade'})} className={`px-4 py-2 rounded-lg font-semibold text-sm ${formData.filterStatus === 'aprovado_gratuidade' ? 'bg-emerald-600 text-white' : 'bg-gray-100 hover:bg-gray-200'}`}>
                          🎁 Aprov. Gratuidade ({allWithdrawals.filter(w => w.status === 'aprovado_gratuidade').length})
                        </button>
                        <button onClick={() => setFormData({...formData, filterStatus: 'rejeitado'})} className={`px-4 py-2 rounded-lg font-semibold text-sm ${formData.filterStatus === 'rejeitado' ? 'bg-red-600 text-white' : 'bg-gray-100 hover:bg-gray-200'}`}>
                          ❌ Rejeitadas ({allWithdrawals.filter(w => w.status === 'rejeitado').length})
                        </button>
                        <button onClick={() => setFormData({...formData, filterStatus: 'inativo'})} className={`px-4 py-2 rounded-lg font-semibold text-sm ${formData.filterStatus === 'inativo' ? 'bg-orange-500 text-white' : 'bg-gray-100 hover:bg-gray-200'}`}>
                          ⚠️ Inativo ({allWithdrawals.filter(w => w.status === 'inativo').length})
                        </button>
                      </div>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm table-fixed">
                        <thead className="bg-gray-50">
                          <tr>
                            <th className="px-2 py-3 text-left w-[130px]">Data</th>
                            <th className="px-2 py-3 text-left w-[140px]">Nome</th>
                            <th className="px-2 py-3 text-left w-[110px]">CPF</th>
                            <th className="px-2 py-3 text-left w-[70px]">Código</th>
                            <th className="px-2 py-3 text-right w-[90px]">Solicitado</th>
                            <th className="px-2 py-3 text-center w-[70px]">Débito</th>
                            <th className="px-2 py-3 text-right w-[90px]">Valor Prof.</th>
                            <th className="px-2 py-3 text-left w-[120px]">PIX</th>
                            <th className="px-2 py-3 text-center w-[160px]">Status</th>
                            <th className="px-2 py-3 text-center w-[50px]">Ações</th>
                          </tr>
                        </thead>
                      <tbody>
                        {allWithdrawals.filter(w => {
                          if (!formData.filterStatus) return true;
                          if (formData.filterStatus === 'atrasados') {
                            return w.status === 'aguardando_aprovacao' && (Date.now() - new Date(w.created_at).getTime()) >= 3600000;
                          }
                          return w.status === formData.filterStatus;
                        }).map(w => {
                          const isAtrasado = w.status === 'aguardando_aprovacao' && (Date.now() - new Date(w.created_at).getTime()) >= 3600000;
                          const tempoEspera = Math.floor((Date.now() - new Date(w.created_at).getTime()) / (1000 * 60));
                          const horasEspera = Math.floor(tempoEspera / 60);
                          const minutosEspera = tempoEspera % 60;
                          
                          // Estilos condicionais
                          const isAprovado = w.status === 'aprovado';
                          const isAprovadoGratuidade = w.status === 'aprovado_gratuidade';
                          const isRejeitado = w.status === 'rejeitado';
                          const rowStyle = isRejeitado 
                            ? 'font-bold text-red-800 bg-red-100' 
                            : isAprovadoGratuidade 
                              ? 'font-bold bg-emerald-100 border-l-4 border-l-emerald-500' 
                              : isAprovado 
                                ? 'font-bold bg-green-100' 
                                : '';
                          
                          return (
                          <tr key={w.id} className={`border-t hover:bg-gray-50 ${isAtrasado && !isRejeitado && !isAprovado && !isAprovadoGratuidade ? 'bg-red-50 border-l-4 border-l-red-500' : ''} ${rowStyle} ${w.has_gratuity && !isAprovado && !isRejeitado && !isAprovadoGratuidade ? 'row-green' : ''} ${w.is_restricted && !isRejeitado ? 'row-red' : ''}`}>
                            <td className={`px-2 py-3 whitespace-nowrap text-xs ${isRejeitado ? 'text-red-800' : isAprovadoGratuidade ? 'text-emerald-800' : isAprovado ? 'text-green-800' : ''}`}>
                              {new Date(w.created_at).toLocaleString('pt-BR')}
                              {isAtrasado && !isAprovado && !isAprovadoGratuidade && !isRejeitado && <p className="text-red-600 text-xs font-bold mt-1">⏰ {horasEspera}h{minutosEspera}m</p>}
                            </td>
                            <td className={`px-2 py-3 text-xs truncate ${isRejeitado ? 'text-red-800' : isAprovadoGratuidade ? 'text-emerald-800' : isAprovado ? 'text-green-800' : ''}`}>{w.user_name}</td>
                            <td className={`px-2 py-3 text-xs ${isRejeitado ? 'text-red-800' : isAprovadoGratuidade ? 'text-emerald-800' : isAprovado ? 'text-green-800' : ''}`}>{w.cpf}</td>
                            <td className={`px-2 py-3 font-mono text-xs ${isRejeitado ? 'text-red-800' : isAprovadoGratuidade ? 'text-emerald-800' : isAprovado ? 'text-green-800' : ''}`}>{w.user_cod}</td>
                            <td className={`px-2 py-3 text-right font-semibold text-xs ${isRejeitado ? 'text-red-800' : isAprovadoGratuidade ? 'text-emerald-800' : isAprovado ? 'text-green-800' : ''}`}>{formatMoney(w.requested_amount)}</td>
                            <td className="px-2 py-3 text-center">
                              <div className="flex flex-col items-center">
                                <input type="checkbox" checked={w.debito || false} onChange={e => handleUpdateDebito(w.id, e.target.checked)} className="w-4 h-4" />
                                {w.debito && w.debito_at && <span className={`text-[10px] mt-1 ${isRejeitado ? 'text-red-800' : isAprovadoGratuidade ? 'text-emerald-800' : isAprovado ? 'text-green-800' : 'text-gray-500'}`}>{new Date(w.debito_at).toLocaleDateString('pt-BR')}</span>}
                              </div>
                            </td>
                            <td className={`px-2 py-3 text-right text-xs ${isRejeitado ? 'text-red-800' : isAprovadoGratuidade ? 'text-emerald-800' : isAprovado ? 'text-green-800' : ''}`}>{formatMoney(w.final_amount)}</td>
                            <td className={`px-2 py-3 ${isRejeitado ? 'text-red-800' : isAprovadoGratuidade ? 'text-emerald-800' : isAprovado ? 'text-green-800' : ''}`}>
                              <div className="flex items-center gap-1">
                                <span className="text-[10px] truncate flex-1" title={w.pix_key}>{w.pix_key}</span>
                                <button 
                                  onClick={() => setPixQRModal({ pix_key: w.pix_key, valor: parseFloat(w.final_amount), nome: w.user_name })} 
                                  className="text-xl hover:scale-110 transition-transform" 
                                  title="Gerar QR Code PIX"
                                >
                                  💠
                                </button>
                              </div>
                            </td>
                            <td className="px-2 py-3">
                              <select value={formData[`showReject_${w.id}`] ? 'rejeitado' : w.status} onChange={e => handleStatusChange(w.id, e.target.value)} className="px-1 py-1 border rounded text-xs w-full">
                                <option value="aguardando_aprovacao">⏳ Aguardando</option>
                                <option value="aprovado">✅ Aprovado</option>
                                <option value="aprovado_gratuidade">✅ c/ Gratuidade</option>
                                <option value="rejeitado">❌ Rejeitado</option>
                                <option value="inativo">⚠️ Inativo</option>
                              </select>
                              {formData[`showReject_${w.id}`] && (
                                <div className="mt-2 space-y-2">
                                  <input type="text" placeholder="Motivo da rejeição..." value={formData[`reject_${w.id}`] || ''} onChange={e => setFormData({...formData, [`reject_${w.id}`]: e.target.value})} className="w-full px-2 py-1 border rounded text-xs" />
                                  <div className="flex gap-1">
                                    <button onClick={() => { if (!formData[`reject_${w.id}`]) { showToast('Informe o motivo', 'error'); return; } handleUpdateWithdrawalStatus(w.id, 'rejeitado', formData[`reject_${w.id}`]); }} className="flex-1 px-2 py-1 bg-red-600 text-white rounded text-xs">Confirmar</button>
                                    <button onClick={() => setFormData({...formData, [`showReject_${w.id}`]: false})} className="px-2 py-1 bg-gray-400 text-white rounded text-xs">✕</button>
                                  </div>
                                </div>
                              )}
                              {w.reject_reason && w.status === 'rejeitado' && <p className="text-[10px] text-red-600 mt-1 truncate">Motivo: {w.reject_reason}</p>}
                              {w.admin_name && w.status !== 'aguardando_aprovacao' && <p className="text-[10px] text-purple-600 mt-1 font-medium">👤 {w.admin_name}</p>}
                            </td>
                            <td className="px-2 py-3 text-center">
                              <button onClick={() => setFormData({...formData, deleteConfirm: w})} className="px-2 py-1 bg-red-600 text-white rounded text-xs hover:bg-red-700" title="Excluir">🗑️</button>
                            </td>
                          </tr>
                        );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
                </>
              )}

              {formData.finTab === 'validacao' && (
                <>
                  {/* Filtros */}
                  <div className="bg-white rounded-xl shadow p-4 mb-6">
                    <div className="flex flex-wrap gap-4 items-end">
                      {/* Tipo de filtro */}
                      <div>
                        <label className="block text-sm font-semibold mb-1">Filtrar por</label>
                        <select value={formData.validacaoTipo || 'solicitacao'} onChange={e => setFormData({...formData, validacaoTipo: e.target.value})} className="px-4 py-2 border rounded-lg">
                          <option value="solicitacao">📅 Data da Solicitação</option>
                          <option value="debito">💳 Data do Débito</option>
                        </select>
                      </div>
                      
                      {/* Data início */}
                      <div>
                        <label className="block text-sm font-semibold mb-1">Data Início</label>
                        <input type="date" value={formData.validacaoDataInicio || ''} onChange={e => setFormData({...formData, validacaoDataInicio: e.target.value})} className="px-4 py-2 border rounded-lg" />
                      </div>
                      
                      {/* Data fim */}
                      <div>
                        <label className="block text-sm font-semibold mb-1">Data Fim</label>
                        <input type="date" value={formData.validacaoDataFim || ''} onChange={e => setFormData({...formData, validacaoDataFim: e.target.value})} className="px-4 py-2 border rounded-lg" />
                      </div>
                      
                      {/* Botões */}
                      <button onClick={() => {
                        const hoje = new Date().toISOString().split('T')[0];
                        setFormData({...formData, validacaoDataInicio: hoje, validacaoDataFim: hoje});
                      }} className="px-6 py-2 bg-green-600 text-white rounded-lg font-semibold hover:bg-green-700">
                        📆 Hoje
                      </button>
                      <button onClick={() => setFormData({...formData, validacaoDataInicio: '', validacaoDataFim: ''})} className="px-6 py-2 bg-gray-200 text-gray-700 rounded-lg font-semibold hover:bg-gray-300">
                        🔄 Limpar
                      </button>
                    </div>
                  </div>

                  {/* Métricas */}
                  {(() => {
                    const tipoFiltro = formData.validacaoTipo || 'solicitacao';
                    const dataInicio = formData.validacaoDataInicio;
                    const dataFim = formData.validacaoDataFim;
                    
                    const filtrados = allWithdrawals.filter(w => {
                      if (!dataInicio && !dataFim) return true;
                      
                      let dataRef;
                      if (tipoFiltro === 'solicitacao') {
                        dataRef = new Date(w.created_at).toISOString().split('T')[0];
                      } else {
                        if (!w.debito_at) return false;
                        dataRef = new Date(w.debito_at).toISOString().split('T')[0];
                      }
                      
                      if (dataInicio && dataFim) {
                        return dataRef >= dataInicio && dataRef <= dataFim;
                      } else if (dataInicio) {
                        return dataRef >= dataInicio;
                      } else if (dataFim) {
                        return dataRef <= dataFim;
                      }
                      return true;
                    });
                    
                    const totalRecebidas = filtrados.length;
                    const rejeitadas = filtrados.filter(w => w.status === 'rejeitado').length;
                    const aprovadasTotal = filtrados.filter(w => w.status === 'aprovado' || w.status === 'aprovado_gratuidade').length;
                    const aprovadasSemGrat = filtrados.filter(w => w.status === 'aprovado').length;
                    const aprovadasComGrat = filtrados.filter(w => w.status === 'aprovado_gratuidade').length;
                    
                    // Lucro com saque: 4.5% do valor solicitado das aprovadas SEM gratuidade
                    const valorAprovadoSemGrat = filtrados.filter(w => w.status === 'aprovado').reduce((acc, w) => acc + parseFloat(w.requested_amount || 0), 0);
                    const lucroComSaque = valorAprovadoSemGrat * 0.045;
                    
                    // Deixou de arrecadar: 4.5% do valor solicitado das aprovadas COM gratuidade
                    const valorAprovadoComGrat = filtrados.filter(w => w.status === 'aprovado_gratuidade').reduce((acc, w) => acc + parseFloat(w.requested_amount || 0), 0);
                    const deixouArrecadar = valorAprovadoComGrat * 0.045;
                    
                    // Valor total das aprovações (com + sem gratuidade)
                    const valorTotalAprovado = valorAprovadoSemGrat + valorAprovadoComGrat;
                    
                    return (
                      <>
                        {/* Período selecionado */}
                        <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 mb-6">
                          <p className="text-blue-800 font-semibold">
                            {tipoFiltro === 'solicitacao' ? '📅 Filtrando por Data da Solicitação' : '💳 Filtrando por Data do Débito'}
                            {dataInicio && dataFim && dataInicio === dataFim && ` - ${new Date(dataInicio + 'T12:00:00').toLocaleDateString('pt-BR')}`}
                            {dataInicio && dataFim && dataInicio !== dataFim && ` - ${new Date(dataInicio + 'T12:00:00').toLocaleDateString('pt-BR')} até ${new Date(dataFim + 'T12:00:00').toLocaleDateString('pt-BR')}`}
                            {!dataInicio && !dataFim && ' - Todos os períodos'}
                          </p>
                        </div>

                        {/* Cards de métricas - Linha 1 */}
                        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 mb-4">
                          <div className="bg-white rounded-xl shadow p-4 border-l-4 border-gray-500">
                            <p className="text-sm text-gray-600">📥 Total Recebidas</p>
                            <p className="text-3xl font-bold text-gray-700">{totalRecebidas}</p>
                          </div>
                          <div className="bg-white rounded-xl shadow p-4 border-l-4 border-green-500">
                            <p className="text-sm text-gray-600">✅ Total Aprovadas</p>
                            <p className="text-3xl font-bold text-green-600">{aprovadasTotal}</p>
                          </div>
                          <div className="bg-white rounded-xl shadow p-4 border-l-4 border-blue-500">
                            <p className="text-sm text-gray-600">✅ Sem Gratuidade</p>
                            <p className="text-3xl font-bold text-blue-600">{aprovadasSemGrat}</p>
                          </div>
                          <div className="bg-white rounded-xl shadow p-4 border-l-4 border-purple-500">
                            <p className="text-sm text-gray-600">🎁 Com Gratuidade</p>
                            <p className="text-3xl font-bold text-purple-600">{aprovadasComGrat}</p>
                          </div>
                          <div className="bg-white rounded-xl shadow p-4 border-l-4 border-red-500">
                            <p className="text-sm text-gray-600">❌ Rejeitadas</p>
                            <p className="text-3xl font-bold text-red-600">{rejeitadas}</p>
                          </div>
                        </div>

                        {/* Cards de métricas - Linha 2 (valores) */}
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                          <div className="bg-gradient-to-r from-blue-500 to-indigo-600 rounded-xl shadow p-6 text-white">
                            <p className="text-sm opacity-90">💵 Valor Total Aprovado</p>
                            <p className="text-4xl font-bold mt-2">{formatMoney(valorTotalAprovado)}</p>
                            <p className="text-xs opacity-75 mt-2">Soma de {aprovadasTotal} aprovações (com + sem gratuidade)</p>
                          </div>
                          <div className="bg-gradient-to-r from-green-500 to-emerald-600 rounded-xl shadow p-6 text-white">
                            <p className="text-sm opacity-90">💰 Lucro com Saque (4,5%)</p>
                            <p className="text-4xl font-bold mt-2">{formatMoney(lucroComSaque)}</p>
                            <p className="text-xs opacity-75 mt-2">Baseado em {aprovadasSemGrat} aprovações sem gratuidade ({formatMoney(valorAprovadoSemGrat)})</p>
                          </div>
                          <div className="bg-gradient-to-r from-red-500 to-orange-500 rounded-xl shadow p-6 text-white">
                            <p className="text-sm opacity-90">📉 Deixou de Arrecadar</p>
                            <p className="text-4xl font-bold mt-2">{formatMoney(deixouArrecadar)}</p>
                            <p className="text-xs opacity-75 mt-2">Baseado em {aprovadasComGrat} aprovações com gratuidade ({formatMoney(valorAprovadoComGrat)})</p>
                          </div>
                        </div>
                      </>
                    );
                  })()}
                </>
              )}

              {formData.finTab === 'conciliacao' && (
                <>
                  <div className="grid md:grid-cols-5 gap-4 mb-6">
                    <div className="bg-white rounded-xl shadow p-4"><p className="text-sm text-gray-600">Aprovados</p><p className="text-2xl font-bold text-green-600">{dashboardData.total_aprovados || 0}</p></div>
                    <div className="bg-white rounded-xl shadow p-4"><p className="text-sm text-gray-600">Conciliados</p><p className="text-2xl font-bold text-blue-600">{dashboardData.total_conciliado || 0}</p></div>
                    <div className="bg-white rounded-xl shadow p-4"><p className="text-sm text-gray-600">Pend. Conc.</p><p className="text-2xl font-bold text-yellow-600">{dashboardData.pendente_conciliacao || 0}</p></div>
                  </div>
                  <div className="bg-white rounded-xl shadow overflow-hidden">
                    <table className="w-full text-sm">
                      <thead className="bg-gray-50"><tr><th className="px-4 py-3 text-left">Nome</th><th className="px-4 py-3 text-left">CPF</th><th className="px-4 py-3 text-left">Código</th><th className="px-4 py-3 text-right">Solicitado</th><th className="px-4 py-3 text-right">Valor Profissional</th><th className="px-4 py-3 text-center">OMIE</th></tr></thead>
                      <tbody>
                        {allWithdrawals.filter(w => w.status?.includes('aprovado')).map(w => (
                          <tr key={w.id} className="border-t hover:bg-gray-50">
                            <td className="px-4 py-3">{w.user_name}</td>
                            <td className="px-4 py-3">{w.cpf}</td>
                            <td className="px-4 py-3 font-mono">{w.user_cod}</td>
                            <td className="px-4 py-3 text-right">{formatMoney(w.requested_amount)}</td>
                            <td className="px-4 py-3 text-right font-semibold">{formatMoney(w.final_amount)}</td>
                            <td className="px-4 py-3 text-center"><input type="checkbox" checked={w.conciliacao_omie} onChange={e => handleUpdateConciliacao(w.id, 'conciliacaoOmie', e.target.checked)} className="w-5 h-5" /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}

              {formData.finTab === 'resumo' && (
                <>
                  {/* Campo de busca */}
                  <div className="bg-white rounded-xl shadow p-4 mb-6">
                    <div className="flex gap-4">
                      <input type="text" placeholder="🔍 Buscar por código do profissional..." value={formData.searchCod || ''} onChange={e => setFormData({...formData, searchCod: e.target.value})} className="flex-1 px-4 py-2 border rounded-lg" />
                      {formData.searchCod && <button onClick={() => setFormData({...formData, searchCod: ''})} className="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg font-semibold">✕ Limpar</button>}
                    </div>
                  </div>

                  {formData.searchCod && (() => {
                    const filtered = allWithdrawals.filter(w => w.user_cod.toLowerCase().includes(formData.searchCod.toLowerCase()));
                    return (
                      <>
                        {/* Cards de estatísticas do profissional */}
                        <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
                          <div className="bg-white rounded-xl shadow p-4">
                            <p className="text-sm text-gray-600">Total</p>
                            <p className="text-2xl font-bold text-purple-600">{filtered.length}</p>
                          </div>
                          <div className="bg-white rounded-xl shadow p-4">
                            <p className="text-sm text-gray-600">Aguardando</p>
                            <p className="text-2xl font-bold text-yellow-600">{filtered.filter(w => w.status === 'aguardando_aprovacao').length}</p>
                          </div>
                          <div className="bg-white rounded-xl shadow p-4">
                            <p className="text-sm text-gray-600">Aprovadas</p>
                            <p className="text-2xl font-bold text-green-600">{filtered.filter(w => w.status === 'aprovado').length}</p>
                          </div>
                          <div className="bg-white rounded-xl shadow p-4">
                            <p className="text-sm text-gray-600">Aprov. Gratuidade</p>
                            <p className="text-2xl font-bold text-emerald-600">{filtered.filter(w => w.status === 'aprovado_gratuidade').length}</p>
                          </div>
                          <div className="bg-white rounded-xl shadow p-4">
                            <p className="text-sm text-gray-600">Rejeitadas</p>
                            <p className="text-2xl font-bold text-red-600">{filtered.filter(w => w.status === 'rejeitado').length}</p>
                          </div>
                        </div>

                        {/* Botões de filtro */}
                        <div className="bg-white rounded-xl shadow overflow-hidden">
                          <div className="p-4 border-b">
                            <div className="flex flex-wrap gap-2">
                              <button onClick={() => setFormData({...formData, resumoFilter: ''})} className={`px-4 py-2 rounded-lg font-semibold text-sm ${!formData.resumoFilter ? 'bg-purple-600 text-white' : 'bg-gray-100 hover:bg-gray-200'}`}>
                                📋 Todas ({filtered.length})
                              </button>
                              <button onClick={() => setFormData({...formData, resumoFilter: 'aguardando_aprovacao'})} className={`px-4 py-2 rounded-lg font-semibold text-sm ${formData.resumoFilter === 'aguardando_aprovacao' ? 'bg-yellow-500 text-white' : 'bg-gray-100 hover:bg-gray-200'}`}>
                                ⏳ Aguardando ({filtered.filter(w => w.status === 'aguardando_aprovacao').length})
                              </button>
                              <button onClick={() => setFormData({...formData, resumoFilter: 'aprovado'})} className={`px-4 py-2 rounded-lg font-semibold text-sm ${formData.resumoFilter === 'aprovado' ? 'bg-green-600 text-white' : 'bg-gray-100 hover:bg-gray-200'}`}>
                                ✅ Aprovadas ({filtered.filter(w => w.status === 'aprovado').length})
                              </button>
                              <button onClick={() => setFormData({...formData, resumoFilter: 'aprovado_gratuidade'})} className={`px-4 py-2 rounded-lg font-semibold text-sm ${formData.resumoFilter === 'aprovado_gratuidade' ? 'bg-emerald-600 text-white' : 'bg-gray-100 hover:bg-gray-200'}`}>
                                🎁 Aprov. Gratuidade ({filtered.filter(w => w.status === 'aprovado_gratuidade').length})
                              </button>
                              <button onClick={() => setFormData({...formData, resumoFilter: 'rejeitado'})} className={`px-4 py-2 rounded-lg font-semibold text-sm ${formData.resumoFilter === 'rejeitado' ? 'bg-red-600 text-white' : 'bg-gray-100 hover:bg-gray-200'}`}>
                                ❌ Rejeitadas ({filtered.filter(w => w.status === 'rejeitado').length})
                              </button>
                              <button onClick={() => setFormData({...formData, resumoFilter: 'inativo'})} className={`px-4 py-2 rounded-lg font-semibold text-sm ${formData.resumoFilter === 'inativo' ? 'bg-orange-500 text-white' : 'bg-gray-100 hover:bg-gray-200'}`}>
                                ⚠️ Inativo ({filtered.filter(w => w.status === 'inativo').length})
                              </button>
                            </div>
                          </div>
                          <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                              <thead className="bg-gray-50"><tr><th className="px-4 py-3 text-left">Data</th><th className="px-4 py-3 text-left">Nome</th><th className="px-4 py-3 text-left">CPF</th><th className="px-4 py-3 text-left">Código</th><th className="px-4 py-3 text-right">Solicitado</th><th className="px-4 py-3 text-right">Valor Profissional</th><th className="px-4 py-3 text-left">PIX</th><th className="px-4 py-3 text-center">Status</th></tr></thead>
                              <tbody>
                                {filtered.filter(w => !formData.resumoFilter || w.status === formData.resumoFilter).map(w => (
                                  <tr key={w.id} className={`border-t hover:bg-gray-50 ${w.has_gratuity ? 'row-green' : ''} ${w.is_restricted ? 'row-red' : ''}`}>
                                    <td className="px-4 py-3 whitespace-nowrap">{new Date(w.created_at).toLocaleString('pt-BR')}</td>
                                    <td className="px-4 py-3">{w.user_name}</td>
                                    <td className="px-4 py-3">{w.cpf}</td>
                                    <td className="px-4 py-3 font-mono">{w.user_cod}</td>
                                    <td className="px-4 py-3 text-right font-semibold">{formatMoney(w.requested_amount)}</td>
                                    <td className="px-4 py-3 text-right">{formatMoney(w.final_amount)}</td>
                                    <td className="px-4 py-3">
                                      <div className="flex items-center gap-1">
                                        <span className="text-xs max-w-[120px] truncate">{w.pix_key}</span>
                                        <button 
                                          onClick={() => setPixQRModal({ pix_key: w.pix_key, valor: parseFloat(w.final_amount), nome: w.user_name })} 
                                          className="text-2xl hover:scale-110 transition-transform" 
                                          title="Gerar QR Code PIX"
                                        >
                                          💠
                                        </button>
                                      </div>
                                    </td>
                                    <td className="px-4 py-3">
                                      <span className={`px-2 py-1 rounded text-xs font-bold ${w.status === 'aprovado' ? 'bg-green-500 text-white' : w.status === 'aprovado_gratuidade' ? 'bg-emerald-500 text-white' : w.status === 'rejeitado' ? 'bg-red-500 text-white' : w.status === 'inativo' ? 'bg-orange-500 text-white' : 'bg-yellow-500 text-white'}`}>
                                        {w.status === 'aguardando_aprovacao' ? '⏳ Aguardando' : w.status === 'aprovado' ? '✅ Aprovado' : w.status === 'aprovado_gratuidade' ? '🎁 c/ Gratuidade' : w.status === 'rejeitado' ? '❌ Rejeitado' : '⚠️ Inativo'}
                                      </span>
                                      {w.reject_reason && w.status === 'rejeitado' && <p className="text-xs text-red-600 mt-1">Motivo: {w.reject_reason}</p>}
                                      {w.admin_name && w.status !== 'aguardando_aprovacao' && <p className="text-xs text-purple-600 mt-1 font-medium">👤 {w.admin_name}</p>}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      </>
                    );
                  })()}

                  {!formData.searchCod && (
                    <div className="bg-white rounded-xl shadow p-8 text-center">
                      <p className="text-gray-500 text-lg">🔍 Digite o código do profissional para ver o resumo</p>
                    </div>
                  )}
                </>
              )}

              {formData.finTab === 'gratuidades' && (
                <div className="space-y-6">
                  <div className="bg-white rounded-xl shadow p-6">
                    <h3 className="text-lg font-semibold mb-4">➕ Cadastrar Gratuidade</h3>
                    <div className="grid md:grid-cols-2 lg:grid-cols-6 gap-4">
                      <div>
                        <label className="block text-xs font-semibold mb-1 text-gray-600">Código *</label>
                        <input 
                          type="text" 
                          placeholder="Código" 
                          value={formData.gratUserCod || ''} 
                          onChange={async (e) => {
                            const cod = e.target.value;
                            setFormData({...formData, gratUserCod: cod, gratUserName: ''});
                            if (cod.length >= 3) {
                              const userFound = users.find(u => u.codProfissional?.toLowerCase() === cod.toLowerCase());
                              if (userFound) {
                                setFormData(prev => ({...prev, gratUserCod: cod, gratUserName: userFound.fullName}));
                              }
                            }
                          }} 
                          className="w-full px-4 py-2 border rounded-lg" 
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold mb-1 text-gray-600">Nome</label>
                        <input 
                          type="text" 
                          placeholder="Nome do usuário" 
                          value={formData.gratUserName || ''} 
                          readOnly
                          className="w-full px-4 py-2 border rounded-lg bg-gray-50 text-gray-700" 
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold mb-1 text-gray-600">Quantidade *</label>
                        <input type="number" placeholder="Qtd" value={formData.gratQty || ''} onChange={e => setFormData({...formData, gratQty: e.target.value})} className="w-full px-4 py-2 border rounded-lg" />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold mb-1 text-gray-600">Valor (R$) *</label>
                        <input type="number" placeholder="Valor" value={formData.gratValue || ''} onChange={e => setFormData({...formData, gratValue: e.target.value})} className="w-full px-4 py-2 border rounded-lg" />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold mb-1 text-gray-600">Motivo</label>
                        <input type="text" placeholder="Motivo" value={formData.gratReason || ''} onChange={e => setFormData({...formData, gratReason: e.target.value})} className="w-full px-4 py-2 border rounded-lg" />
                      </div>
                      <div className="flex items-end">
                        <button onClick={handleAddGratuity} disabled={loading || !formData.gratUserName} className="w-full px-4 py-2 bg-purple-600 text-white rounded-lg font-semibold disabled:opacity-50">➕ Adicionar</button>
                      </div>
                    </div>
                    {formData.gratUserCod && !formData.gratUserName && formData.gratUserCod.length >= 3 && (
                      <p className="text-red-500 text-xs mt-2">⚠️ Usuário não encontrado com este código</p>
                    )}
                    {formData.gratUserName && (
                      <p className="text-green-600 text-xs mt-2">✅ Usuário encontrado: {formData.gratUserName}</p>
                    )}
                  </div>
                  <div className="bg-white rounded-xl shadow overflow-hidden">
                    <table className="w-full text-sm">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="px-4 py-3 text-left">Código</th>
                          <th className="px-4 py-3 text-left">Nome</th>
                          <th className="px-4 py-3 text-center">Qtd</th>
                          <th className="px-4 py-3 text-center">Rest.</th>
                          <th className="px-4 py-3 text-right">Valor</th>
                          <th className="px-4 py-3 text-left">Motivo</th>
                          <th className="px-4 py-3 text-left">Cadastrado por</th>
                          <th className="px-4 py-3 text-center">Status</th>
                          <th className="px-4 py-3 text-center">Ação</th>
                        </tr>
                      </thead>
                      <tbody>
                        {gratuities.map(g => (
                          <tr key={g.id} className={`border-t ${g.status === 'ativa' ? 'bg-green-50' : ''}`}>
                            <td className="px-4 py-3 font-mono">{g.user_cod}</td>
                            <td className="px-4 py-3 font-semibold">{g.user_name || '-'}</td>
                            <td className="px-4 py-3 text-center">{g.quantity}</td>
                            <td className="px-4 py-3 text-center font-bold">{g.remaining}</td>
                            <td className="px-4 py-3 text-right">{formatMoney(g.value)}</td>
                            <td className="px-4 py-3">{g.reason || '-'}</td>
                            <td className="px-4 py-3 text-xs text-gray-600">{g.created_by || '-'}</td>
                            <td className="px-4 py-3 text-center"><span className={`px-2 py-1 rounded text-xs font-bold ${g.status === 'ativa' ? 'bg-green-500 text-white' : 'bg-gray-400 text-white'}`}>{g.status}</span></td>
                            <td className="px-4 py-3 text-center">
                              <button 
                                onClick={() => {
                                  if (confirm(`⚠️ Excluir gratuidade de ${g.user_name || g.user_cod}?\n\nValor: ${formatMoney(g.value)}\nRestante: ${g.remaining}/${g.quantity}\n\nEsta ação não pode ser desfeita!`)) {
                                    handleDeleteGratuity(g.id);
                                  }
                                }} 
                                className="px-3 py-1 bg-red-600 text-white rounded text-xs hover:bg-red-700"
                              >
                                🗑️ Excluir
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {formData.finTab === 'restritos' && (
                <div className="space-y-6">
                  <div className="bg-white rounded-xl shadow p-6">
                    <h3 className="text-lg font-semibold mb-4">➕ Adicionar Restrição</h3>
                    <div className="grid md:grid-cols-4 gap-4">
                      <div>
                        <label className="block text-xs font-semibold mb-1 text-gray-600">Código *</label>
                        <input 
                          type="text" 
                          placeholder="Código" 
                          value={formData.restUserCod || ''} 
                          onChange={async (e) => {
                            const cod = e.target.value;
                            setFormData({...formData, restUserCod: cod, restUserName: ''});
                            if (cod.length >= 3) {
                              const userFound = users.find(u => u.codProfissional?.toLowerCase() === cod.toLowerCase());
                              if (userFound) {
                                setFormData(prev => ({...prev, restUserCod: cod, restUserName: userFound.fullName}));
                              }
                            }
                          }} 
                          className="w-full px-4 py-2 border rounded-lg" 
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold mb-1 text-gray-600">Nome</label>
                        <input 
                          type="text" 
                          placeholder="Nome do usuário" 
                          value={formData.restUserName || ''} 
                          readOnly
                          className="w-full px-4 py-2 border rounded-lg bg-gray-50 text-gray-700" 
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold mb-1 text-gray-600">Motivo *</label>
                        <input 
                          type="text" 
                          placeholder="Motivo" 
                          value={formData.restReason || ''} 
                          onChange={e => setFormData({...formData, restReason: e.target.value})} 
                          className="w-full px-4 py-2 border rounded-lg" 
                        />
                      </div>
                      <div className="flex items-end">
                        <button onClick={handleAddRestriction} disabled={loading || !formData.restUserName} className="w-full px-4 py-2 bg-red-600 text-white rounded-lg font-semibold disabled:opacity-50">🚫 Adicionar</button>
                      </div>
                    </div>
                    {formData.restUserCod && !formData.restUserName && formData.restUserCod.length >= 3 && (
                      <p className="text-red-500 text-xs mt-2">⚠️ Usuário não encontrado com este código</p>
                    )}
                    {formData.restUserName && (
                      <p className="text-green-600 text-xs mt-2">✅ Usuário encontrado: {formData.restUserName}</p>
                    )}
                  </div>
                  <div className="bg-white rounded-xl shadow overflow-hidden">
                    <table className="w-full text-sm">
                      <thead className="bg-gray-50"><tr><th className="px-4 py-3 text-left">Código</th><th className="px-4 py-3 text-left">Nome</th><th className="px-4 py-3 text-left">Motivo</th><th className="px-4 py-3 text-left">Cadastrado por</th><th className="px-4 py-3 text-left">Data</th><th className="px-4 py-3 text-center">Status</th><th className="px-4 py-3 text-center">Ação</th></tr></thead>
                      <tbody>
                        {restrictedList.map(r => (
                          <tr key={r.id} className={`border-t ${r.status === 'ativo' ? 'bg-red-50' : ''}`}>
                            <td className="px-4 py-3 font-mono">{r.user_cod}</td>
                            <td className="px-4 py-3 font-semibold">{r.user_name || '-'}</td>
                            <td className="px-4 py-3">{r.reason}</td>
                            <td className="px-4 py-3 text-xs text-gray-600">{r.created_by || '-'}</td>
                            <td className="px-4 py-3">{new Date(r.created_at).toLocaleDateString('pt-BR')}</td>
                            <td className="px-4 py-3 text-center"><span className={`px-2 py-1 rounded text-xs font-bold ${r.status === 'ativo' ? 'bg-red-500 text-white' : 'bg-gray-400 text-white'}`}>{r.status}</span></td>
                            <td className="px-4 py-3 text-center">{r.status === 'ativo' && <button onClick={() => handleRemoveRestriction(r.id)} className="px-3 py-1 bg-green-600 text-white rounded text-xs">Suspender</button>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* ========== ABA INDICAÇÕES ========== */}
              {formData.finTab === 'indicacoes' && (
                <>
                  {/* Modal de rejeição */}
                  {formData.modalRejeitar && (
                    <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4">
                      <div className="bg-white rounded-xl shadow-2xl p-6 max-w-md w-full">
                        <h3 className="text-xl font-bold text-red-600 mb-4">❌ Rejeitar Indicação</h3>
                        <div className="bg-gray-50 rounded-lg p-4 mb-4">
                          <p className="text-sm"><strong>Profissional:</strong> {formData.modalRejeitar.user_name}</p>
                          <p className="text-sm"><strong>Indicado:</strong> {formData.modalRejeitar.indicado_nome}</p>
                          <p className="text-sm"><strong>Região:</strong> {formData.modalRejeitar.regiao}</p>
                        </div>
                        <div className="mb-4">
                          <label className="block text-sm font-semibold mb-1">Motivo da Rejeição *</label>
                          <textarea 
                            value={formData.motivoRejeicao || ''} 
                            onChange={e => setFormData({...formData, motivoRejeicao: e.target.value})} 
                            className="w-full px-4 py-2 border rounded-lg"
                            rows="3"
                            placeholder="Informe o motivo..."
                          />
                        </div>
                        <div className="flex gap-3">
                          <button onClick={() => setFormData({...formData, modalRejeitar: null, motivoRejeicao: ''})} className="flex-1 px-4 py-2 bg-gray-200 text-gray-700 rounded-lg font-semibold hover:bg-gray-300">Cancelar</button>
                          <button onClick={() => handleRejeitarIndicacao(formData.modalRejeitar.id)} disabled={!formData.motivoRejeicao || loading} className="flex-1 px-4 py-2 bg-red-600 text-white rounded-lg font-semibold hover:bg-red-700 disabled:opacity-50">
                            {loading ? '...' : '❌ Rejeitar'}
                          </button>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Cadastrar/Editar Promoção */}
                  <div className="bg-white rounded-xl shadow p-6 mb-6">
                    <div className="flex justify-between items-center mb-4">
                      <h2 className="text-xl font-bold text-green-800">
                        {formData.editPromo ? '✏️ Editar Promoção' : '📣 Cadastrar Nova Promoção'}
                      </h2>
                      {formData.editPromo && (
                        <button 
                          onClick={() => setFormData({...formData, editPromo: null, promoRegiao: '', promoValor: '', promoDetalhes: ''})}
                          className="text-sm text-gray-500 hover:text-gray-700"
                        >
                          ✕ Cancelar edição
                        </button>
                      )}
                    </div>
                    <div className="grid md:grid-cols-2 gap-4 mb-4">
                      <div>
                        <label className="block text-sm font-semibold mb-1">Região *</label>
                        <input 
                          type="text" 
                          value={formData.promoRegiao || ''} 
                          onChange={e => setFormData({...formData, promoRegiao: e.target.value})} 
                          className="w-full px-4 py-2 border rounded-lg"
                          placeholder="Ex: Salvador - BA"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-semibold mb-1">Valor do Bônus (R$) *</label>
                        <input 
                          type="number" 
                          step="0.01"
                          value={formData.promoValor || ''} 
                          onChange={e => setFormData({...formData, promoValor: e.target.value})} 
                          className="w-full px-4 py-2 border rounded-lg"
                          placeholder="Ex: 100.00"
                        />
                      </div>
                    </div>
                    <div className="mb-4">
                      <label className="block text-sm font-semibold mb-1">Detalhes da Promoção (opcional)</label>
                      <textarea 
                        value={formData.promoDetalhes || ''} 
                        onChange={e => setFormData({...formData, promoDetalhes: e.target.value})} 
                        className="w-full px-4 py-2 border rounded-lg"
                        rows="3"
                        placeholder="Ex: Vaga para instalador com experiência em fibra óptica. Início imediato. Benefícios: vale transporte + alimentação..."
                      />
                    </div>
                    <button onClick={formData.editPromo ? handleEditarPromocao : handleCriarPromocao} disabled={loading} className={`w-full md:w-auto px-6 py-2 text-white rounded-lg font-semibold disabled:opacity-50 ${formData.editPromo ? 'bg-blue-600 hover:bg-blue-700' : 'bg-green-600 hover:bg-green-700'}`}>
                      {loading ? '...' : formData.editPromo ? '💾 Salvar Alterações' : '➕ Criar Promoção'}
                    </button>
                  </div>

                  {/* Promoções Ativas */}
                  <div className="bg-white rounded-xl shadow p-6 mb-6">
                    <h3 className="font-semibold mb-4">📋 Promoções Cadastradas</h3>
                    {promocoes.length === 0 ? (
                      <p className="text-gray-500 text-center py-4">Nenhuma promoção cadastrada</p>
                    ) : (
                      <div className="grid md:grid-cols-4 gap-3">
                        {promocoes.map(p => (
                          <div key={p.id} className={`border rounded-lg p-3 ${p.status === 'ativa' ? 'border-green-300 bg-green-50' : 'border-gray-300 bg-gray-50'}`}>
                            <div className="flex justify-between items-center mb-1">
                              <span className={`px-2 py-0.5 rounded text-xs font-bold ${p.status === 'ativa' ? 'bg-green-500 text-white' : 'bg-gray-500 text-white'}`}>
                                {p.status === 'ativa' ? '✅' : '⏸️'}
                              </span>
                              <div className="flex gap-1">
                                <button 
                                  onClick={() => setFormData({...formData, editPromo: p, promoRegiao: p.regiao, promoValor: p.valor_bonus, promoDetalhes: p.detalhes || ''})}
                                  className="text-xs text-blue-500 hover:text-blue-700"
                                >✏️</button>
                                <button 
                                  onClick={async () => {
                                    await fetch(`${API_URL}/promocoes/${p.id}`, {
                                      method: 'PATCH',
                                      headers: { 'Content-Type': 'application/json' },
                                      body: JSON.stringify({ status: p.status === 'ativa' ? 'inativa' : 'ativa' })
                                    });
                                    loadPromocoes();
                                  }}
                                  className="text-xs text-gray-500 hover:text-gray-700"
                                >
                                  {p.status === 'ativa' ? '⏸️' : '▶️'}
                                </button>
                              </div>
                            </div>
                            <p className="font-semibold text-sm">📍 {p.regiao}</p>
                            <p className="text-lg font-bold text-green-600">{formatMoney(p.valor_bonus)}</p>
                            {p.detalhes && (
                              <p className="text-xs text-gray-600 mt-1 whitespace-pre-wrap line-clamp-3" title={p.detalhes}>{p.detalhes}</p>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Cards de estatísticas */}
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
                    <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-4 text-center">
                      <p className="text-3xl font-bold text-yellow-600">{indicacoes.filter(i => i.status === 'pendente').length}</p>
                      <p className="text-sm text-yellow-700">Pendentes</p>
                    </div>
                    <div className="bg-green-50 border border-green-200 rounded-xl p-4 text-center">
                      <p className="text-3xl font-bold text-green-600">{indicacoes.filter(i => i.status === 'aprovada').length}</p>
                      <p className="text-sm text-green-700">Aprovadas</p>
                    </div>
                    <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-center">
                      <p className="text-3xl font-bold text-red-600">{indicacoes.filter(i => i.status === 'rejeitada').length}</p>
                      <p className="text-sm text-red-700">Rejeitadas</p>
                    </div>
                    <div className="bg-gray-50 border border-gray-200 rounded-xl p-4 text-center">
                      <p className="text-3xl font-bold text-gray-600">{indicacoes.filter(i => i.status === 'expirada').length}</p>
                      <p className="text-sm text-gray-700">Expiradas</p>
                    </div>
                  </div>

                  {/* Tabela de Indicações */}
                  <div className="bg-white rounded-xl shadow p-6">
                    <h3 className="font-semibold mb-4">👥 Indicações Recebidas</h3>
                    {indicacoes.length === 0 ? (
                      <p className="text-gray-500 text-center py-8">Nenhuma indicação recebida</p>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead className="bg-gray-50">
                            <tr>
                              <th className="px-2 py-3 text-left text-xs">Data</th>
                              <th className="px-2 py-3 text-left text-xs">Profissional</th>
                              <th className="px-2 py-3 text-left text-xs">Indicado</th>
                              <th className="px-2 py-3 text-left text-xs">Contato</th>
                              <th className="px-2 py-3 text-left text-xs">Região</th>
                              <th className="px-2 py-3 text-center text-xs">Bônus</th>
                              <th className="px-2 py-3 text-center text-xs">Expira</th>
                              <th className="px-3 py-3 text-center">Status</th>
                              <th className="px-3 py-3 text-center">Crédito Lançado</th>
                              <th className="px-3 py-3 text-center">Ações</th>
                            </tr>
                          </thead>
                          <tbody>
                            {indicacoes.map(ind => {
                              const diasRestantes = Math.ceil((new Date(ind.expires_at) - new Date()) / (1000 * 60 * 60 * 24));
                              const telefoneNumeros = ind.indicado_contato ? ind.indicado_contato.replace(/\D/g, '') : '';
                              const whatsappLink = telefoneNumeros ? `https://wa.me/55${telefoneNumeros}` : '#';
                              return (
                                <tr key={ind.id} className={`border-t ${ind.status === 'pendente' ? 'bg-yellow-50' : ''}`}>
                                  <td className="px-2 py-3 whitespace-nowrap text-xs">{new Date(ind.created_at).toLocaleDateString('pt-BR')}</td>
                                  <td className="px-2 py-3">
                                    <p className="font-semibold text-xs">{ind.user_name}</p>
                                    <p className="text-xs text-gray-500">{ind.user_cod}</p>
                                  </td>
                                  <td className="px-2 py-3">
                                    <p className="font-semibold text-xs">{ind.indicado_nome}</p>
                                    {ind.indicado_cpf && <p className="text-xs text-gray-500">{ind.indicado_cpf}</p>}
                                  </td>
                                  <td className="px-2 py-3">
                                    <a href={whatsappLink} target="_blank" rel="noopener noreferrer" className="text-green-600 hover:text-green-800 font-semibold text-xs flex items-center gap-1">
                                      📱 {ind.indicado_contato}
                                    </a>
                                  </td>
                                  <td className="px-2 py-3 text-xs">{ind.regiao}</td>
                                  <td className="px-2 py-3 text-center font-bold text-green-600 text-xs">{formatMoney(ind.valor_bonus)}</td>
                                  <td className="px-2 py-3 text-center">
                                    {ind.status === 'pendente' ? (
                                      <span className={`text-xs font-bold ${diasRestantes <= 5 ? 'text-red-600' : 'text-gray-600'}`}>
                                        {diasRestantes > 0 ? `${diasRestantes}d` : 'Exp'}
                                      </span>
                                    ) : '-'}
                                  </td>
                                  <td className="px-3 py-3 text-center">
                                    <div className="flex flex-col items-center">
                                      <span className={`px-2 py-1 rounded-full text-xs font-bold ${
                                        ind.status === 'pendente' ? 'bg-yellow-500 text-white' :
                                        ind.status === 'aprovada' ? 'bg-green-500 text-white' :
                                        ind.status === 'rejeitada' ? 'bg-red-500 text-white' :
                                        'bg-gray-500 text-white'
                                      }`}>
                                        {ind.status === 'pendente' ? '⏳ Pendente' :
                                         ind.status === 'aprovada' ? '✅ Aprovada' :
                                         ind.status === 'rejeitada' ? '❌ Rejeitada' :
                                         '⏰ Expirada'}
                                      </span>
                                      {(ind.status === 'aprovada' || ind.status === 'rejeitada') && ind.resolved_by && (
                                        <span className="text-xs text-gray-500 mt-1">{ind.resolved_by}</span>
                                      )}
                                    </div>
                                  </td>
                                  <td className="px-3 py-3 text-center">
                                    {ind.status === 'aprovada' && (
                                      <div className="flex flex-col items-center">
                                        <input 
                                          type="checkbox" 
                                          checked={ind.credito_lancado || false}
                                          onChange={async (e) => {
                                            try {
                                              await fetch(`${API_URL}/indicacoes/${ind.id}/credito`, {
                                                method: 'PATCH',
                                                headers: { 'Content-Type': 'application/json' },
                                                body: JSON.stringify({ credito_lancado: e.target.checked, lancado_por: user.fullName })
                                              });
                                              loadIndicacoes();
                                            } catch (err) { showToast('Erro ao atualizar', 'error'); }
                                          }}
                                          className="w-5 h-5 cursor-pointer"
                                        />
                                        {ind.credito_lancado && ind.lancado_por && (
                                          <span className="text-xs text-gray-500 mt-1">{ind.lancado_por}</span>
                                        )}
                                      </div>
                                    )}
                                  </td>
                                  <td className="px-3 py-3 text-center">
                                    {ind.status === 'pendente' && (
                                      <div className="flex gap-2 justify-center">
                                        <button onClick={() => handleAprovarIndicacao(ind.id)} className="px-3 py-1 bg-green-600 text-white rounded text-xs hover:bg-green-700">✅ Aprovar</button>
                                        <button onClick={() => setFormData({...formData, modalRejeitar: ind})} className="px-3 py-1 bg-red-600 text-white rounded text-xs hover:bg-red-700">❌ Rejeitar</button>
                                      </div>
                                    )}
                                    {ind.status === 'rejeitada' && ind.motivo_rejeicao && (
                                      <span className="text-xs text-red-600" title={ind.motivo_rejeicao}>📝 {ind.motivo_rejeicao.substring(0, 20)}...</span>
                                    )}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                </>
              )}

              {/* ========== ABA PROMO NOVATOS ========== */}
              {formData.finTab === 'promo-novatos' && (
                <>
                  {/* Modal de Rejeição */}
                  {formData.modalRejeitarNovatos && (
                    <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4">
                      <div className="bg-white rounded-xl p-6 w-full max-w-md">
                        <h3 className="text-lg font-bold mb-4">❌ Rejeitar Inscrição</h3>
                        <p className="text-sm text-gray-600 mb-3">
                          Profissional: <strong>{formData.modalRejeitarNovatos.user_name}</strong><br/>
                          Cliente: <strong>{formData.modalRejeitarNovatos.cliente}</strong>
                        </p>
                        <div className="mb-4">
                          <label className="block text-sm font-semibold mb-1">Motivo da Rejeição *</label>
                          <textarea 
                            value={formData.motivoRejeicaoNovato || ''} 
                            onChange={e => setFormData({...formData, motivoRejeicaoNovato: e.target.value})} 
                            className="w-full px-4 py-2 border rounded-lg"
                            rows="3"
                            placeholder="Informe o motivo..."
                          />
                        </div>
                        <div className="flex gap-3">
                          <button onClick={() => setFormData({...formData, modalRejeitarNovatos: null, motivoRejeicaoNovato: ''})} className="flex-1 px-4 py-2 bg-gray-200 text-gray-700 rounded-lg font-semibold hover:bg-gray-300">Cancelar</button>
                          <button onClick={() => handleRejeitarInscricaoNovato(formData.modalRejeitarNovatos.id)} disabled={!formData.motivoRejeicaoNovato || loading} className="flex-1 px-4 py-2 bg-red-600 text-white rounded-lg font-semibold hover:bg-red-700 disabled:opacity-50">
                            {loading ? '...' : '❌ Rejeitar'}
                          </button>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* ========== QUIZ DE PROCEDIMENTOS (DROPDOWN) ========== */}
                  <div className="bg-gradient-to-r from-purple-600 to-purple-800 rounded-xl shadow-lg mb-6 text-white overflow-hidden">
                    {/* Header - Sempre visível */}
                    <div 
                      className="p-4 flex justify-between items-center cursor-pointer hover:bg-white/10 transition"
                      onClick={() => setQuizExpandido(!quizExpandido)}
                    >
                      <div className="flex items-center gap-3">
                        <span className="text-2xl">🎯</span>
                        <div>
                          <h2 className="text-lg font-bold">Quiz de Procedimentos</h2>
                          <p className="text-purple-200 text-xs">Clique para {quizExpandido ? 'recolher' : 'expandir'} configurações</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className={`px-3 py-1 rounded-full text-xs font-bold ${quizConfig.ativo ? 'bg-green-500' : 'bg-red-500'}`}>
                          {quizConfig.ativo ? '✅ ATIVO' : '❌ INATIVO'}
                        </span>
                        <span className="text-2xl transition-transform" style={{transform: quizExpandido ? 'rotate(180deg)' : 'rotate(0deg)'}}>
                          ▼
                        </span>
                      </div>
                    </div>
                    
                    {/* Conteúdo colapsável */}
                    {quizExpandido && (
                      <div className="p-6 pt-2 border-t border-white/20">
                        {/* Ativar/Desativar */}
                        <div className="flex justify-end mb-4">
                          <button 
                            onClick={() => setQuizConfig({...quizConfig, ativo: !quizConfig.ativo})}
                            className={`px-4 py-2 rounded-lg font-semibold text-sm ${quizConfig.ativo ? 'bg-red-500 hover:bg-red-600' : 'bg-green-500 hover:bg-green-600'}`}
                          >
                            {quizConfig.ativo ? '⏸️ Desativar Quiz' : '▶️ Ativar Quiz'}
                          </button>
                        </div>
                        
                        {/* Título e Valor */}
                        <div className="grid md:grid-cols-2 gap-4 mb-4">
                          <div>
                            <label className="block text-sm font-semibold mb-1">Título da Promoção</label>
                            <input 
                              type="text" 
                              value={quizConfig.titulo} 
                              onChange={e => setQuizConfig({...quizConfig, titulo: e.target.value})} 
                              className="w-full px-4 py-2 border rounded-lg text-gray-800"
                              placeholder="Acerte os procedimentos..."
                            />
                          </div>
                          <div>
                            <label className="block text-sm font-semibold mb-1">Valor da Gratuidade (R$)</label>
                            <input 
                              type="number" 
                              step="0.01"
                              value={quizConfig.valor_gratuidade} 
                              onChange={e => setQuizConfig({...quizConfig, valor_gratuidade: parseFloat(e.target.value) || 0})} 
                              className="w-full px-4 py-2 border rounded-lg text-gray-800"
                            />
                          </div>
                        </div>

                        {/* 4 Imagens */}
                        <div className="mb-4">
                          <label className="block text-sm font-semibold mb-2">📸 4 Imagens do Carrossel</label>
                          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                            {[0, 1, 2, 3].map(i => (
                              <div key={i} className="relative">
                                <div className="aspect-video bg-white/20 rounded-lg overflow-hidden border-2 border-dashed border-white/50 flex items-center justify-center">
                                  {quizConfig.imagens[i] ? (
                                    <img src={quizConfig.imagens[i]} alt={`Imagem ${i+1}`} className="w-full h-full object-cover" />
                                  ) : (
                                    <span className="text-white/70 text-sm">Imagem {i+1}</span>
                                  )}
                                </div>
                                <input 
                                  type="file" 
                                  accept="image/*"
                                  onChange={e => handleImagemQuiz(i, e.target.files[0])}
                                  className="absolute inset-0 opacity-0 cursor-pointer"
                                />
                                {quizConfig.imagens[i] && (
                                  <button 
                                    onClick={() => {
                                      const novas = [...quizConfig.imagens];
                                      novas[i] = null;
                                      setQuizConfig({...quizConfig, imagens: novas});
                                    }}
                                    className="absolute top-1 right-1 w-6 h-6 bg-red-500 text-white rounded-full text-xs hover:bg-red-600"
                                  >✕</button>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>

                        {/* 5 Perguntas */}
                        <div className="mb-4">
                          <label className="block text-sm font-semibold mb-2">❓ 5 Afirmações (CERTO ou ERRADO)</label>
                          <div className="space-y-3">
                            {[0, 1, 2, 3, 4].map(i => (
                              <div key={i} className="flex gap-3 items-center bg-white/10 rounded-lg p-3">
                                <span className="font-bold text-lg">{i+1}.</span>
                                <input 
                                  type="text" 
                                  value={quizConfig.perguntas[i]?.texto || ''} 
                                  onChange={e => {
                                    const novas = [...quizConfig.perguntas];
                                    novas[i] = { ...novas[i], texto: e.target.value };
                                    setQuizConfig({...quizConfig, perguntas: novas});
                                  }}
                                  className="flex-1 px-3 py-2 border rounded-lg text-gray-800"
                                  placeholder={`Afirmação ${i+1}...`}
                                />
                                <div className="flex gap-2">
                                  <button 
                                    onClick={() => {
                                      const novas = [...quizConfig.perguntas];
                                      novas[i] = { ...novas[i], resposta: true };
                                      setQuizConfig({...quizConfig, perguntas: novas});
                                    }}
                                    className={`px-3 py-2 rounded-lg font-semibold text-sm ${quizConfig.perguntas[i]?.resposta === true ? 'bg-green-500' : 'bg-white/20 hover:bg-white/30'}`}
                                  >
                                    CERTO
                                  </button>
                                  <button 
                                    onClick={() => {
                                      const novas = [...quizConfig.perguntas];
                                      novas[i] = { ...novas[i], resposta: false };
                                      setQuizConfig({...quizConfig, perguntas: novas});
                                    }}
                                    className={`px-3 py-2 rounded-lg font-semibold text-sm ${quizConfig.perguntas[i]?.resposta === false ? 'bg-red-500' : 'bg-white/20 hover:bg-white/30'}`}
                                  >
                                    ERRADO
                                  </button>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>

                        <button 
                          onClick={handleSalvarQuizConfig}
                          disabled={loading}
                          className="w-full py-3 bg-white text-purple-700 rounded-lg font-bold hover:bg-purple-50 disabled:opacity-50"
                        >
                          {loading ? 'Salvando...' : '💾 Salvar Configuração do Quiz'}
                        </button>
                      </div>
                    )}
                  </div>

                  {/* ========== HISTÓRICO DO QUIZ ========== */}
                  <div className="bg-white rounded-xl shadow p-6 mb-6">
                    <div className="flex justify-between items-center mb-4">
                      <h3 className="font-bold text-lg text-purple-700">📊 Histórico do Quiz</h3>
                      <div className="flex gap-2">
                        <span className="px-3 py-1 bg-blue-100 text-blue-700 rounded-full text-sm font-bold">
                          {quizRespostas.length} participantes
                        </span>
                        <span className="px-3 py-1 bg-green-100 text-green-700 rounded-full text-sm font-bold">
                          {quizRespostas.filter(r => r.passou).length} contemplados
                        </span>
                      </div>
                    </div>
                    
                    {/* Cards de estatísticas */}
                    <div className="grid grid-cols-4 gap-3 mb-4">
                      <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-center">
                        <p className="text-2xl font-bold text-blue-600">{quizRespostas.length}</p>
                        <p className="text-xs text-blue-700">Total</p>
                      </div>
                      <div className="bg-green-50 border border-green-200 rounded-lg p-3 text-center">
                        <p className="text-2xl font-bold text-green-600">{quizRespostas.filter(r => r.passou).length}</p>
                        <p className="text-xs text-green-700">Contemplados</p>
                      </div>
                      <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-center">
                        <p className="text-2xl font-bold text-red-600">{quizRespostas.filter(r => !r.passou).length}</p>
                        <p className="text-xs text-red-700">Não passou</p>
                      </div>
                      <div className="bg-purple-50 border border-purple-200 rounded-lg p-3 text-center">
                        <p className="text-2xl font-bold text-purple-600">
                          {formatMoney(quizRespostas.filter(r => r.passou).length * (quizConfig.valor_gratuidade || 500))}
                        </p>
                        <p className="text-xs text-purple-700">Total Gratuidades</p>
                      </div>
                    </div>
                    
                    {quizRespostas.length === 0 ? (
                      <p className="text-gray-500 text-center py-8">Nenhum participante ainda</p>
                    ) : (
                      <div className="overflow-x-auto max-h-80">
                        <table className="w-full text-sm">
                          <thead className="bg-gray-100 sticky top-0">
                            <tr>
                              <th className="px-3 py-2 text-left font-semibold">Data/Hora</th>
                              <th className="px-3 py-2 text-left font-semibold">Profissional</th>
                              <th className="px-3 py-2 text-left font-semibold">COD</th>
                              <th className="px-3 py-2 text-center font-semibold">Acertos</th>
                              <th className="px-3 py-2 text-center font-semibold">Resultado</th>
                              <th className="px-3 py-2 text-center font-semibold">Gratuidade</th>
                            </tr>
                          </thead>
                          <tbody>
                            {quizRespostas.map(r => (
                              <tr key={r.id} className={`border-b hover:bg-gray-50 ${r.passou ? 'bg-green-50' : ''}`}>
                                <td className="px-3 py-2 text-xs text-gray-600">
                                  {new Date(r.created_at).toLocaleDateString('pt-BR')} {new Date(r.created_at).toLocaleTimeString('pt-BR', {hour: '2-digit', minute: '2-digit'})}
                                </td>
                                <td className="px-3 py-2 font-medium">{r.user_name}</td>
                                <td className="px-3 py-2 text-gray-600">{r.user_cod}</td>
                                <td className="px-3 py-2 text-center">
                                  <span className={`font-bold ${r.acertos === 5 ? 'text-green-600' : 'text-red-600'}`}>
                                    {r.acertos}/5
                                  </span>
                                </td>
                                <td className="px-3 py-2 text-center">
                                  <span className={`px-2 py-1 rounded-full text-xs font-bold ${r.passou ? 'bg-green-500 text-white' : 'bg-red-400 text-white'}`}>
                                    {r.passou ? '✅ Contemplado' : '❌ Não passou'}
                                  </span>
                                </td>
                                <td className="px-3 py-2 text-center">
                                  {r.passou ? (
                                    <span className="font-bold text-green-600">{formatMoney(quizConfig.valor_gratuidade || 500)}</span>
                                  ) : (
                                    <span className="text-gray-400">-</span>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>

                  <hr className="my-6 border-gray-300" />
                  <h3 className="text-lg font-bold text-gray-700 mb-4">📋 Promoções por Cliente/Região</h3>

                  {/* Cadastrar/Editar Promoção Novatos */}
                  <div className="bg-white rounded-xl shadow p-6 mb-6">
                    <div className="flex justify-between items-center mb-4">
                      <h2 className="text-xl font-bold text-green-800">
                        {formData.editPromoNovatos ? '✏️ Editar Promoção Novatos' : '🚀 Cadastrar Nova Promoção Novatos'}
                      </h2>
                      {formData.editPromoNovatos && (
                        <button 
                          onClick={() => setFormData({...formData, editPromoNovatos: null, novatosRegiao: '', novatosCliente: '', novatosValor: '', novatosDetalhes: ''})}
                          className="text-sm text-gray-500 hover:text-gray-700"
                        >
                          ✕ Cancelar edição
                        </button>
                      )}
                    </div>
                    <div className="grid md:grid-cols-3 gap-4 mb-4">
                      <div>
                        <label className="block text-sm font-semibold mb-1">Região *</label>
                        <input 
                          type="text" 
                          value={formData.novatosRegiao || ''} 
                          onChange={e => setFormData({...formData, novatosRegiao: e.target.value})} 
                          className="w-full px-4 py-2 border rounded-lg"
                          placeholder="Ex: Salvador - BA"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-semibold mb-1">Cliente *</label>
                        <input 
                          type="text" 
                          value={formData.novatosCliente || ''} 
                          onChange={e => setFormData({...formData, novatosCliente: e.target.value})} 
                          className="w-full px-4 py-2 border rounded-lg"
                          placeholder="Ex: Magazine Luiza"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-semibold mb-1">Valor do Bônus (R$) *</label>
                        <input 
                          type="number" 
                          step="0.01"
                          value={formData.novatosValor || ''} 
                          onChange={e => setFormData({...formData, novatosValor: e.target.value})} 
                          className="w-full px-4 py-2 border rounded-lg"
                          placeholder="Ex: 150.00"
                        />
                      </div>
                    </div>
                    <div className="mb-4">
                      <label className="block text-sm font-semibold mb-1">Detalhes da Promoção (opcional)</label>
                      <textarea 
                        value={formData.novatosDetalhes || ''} 
                        onChange={e => setFormData({...formData, novatosDetalhes: e.target.value})} 
                        className="w-full px-4 py-2 border rounded-lg"
                        rows="3"
                        placeholder="Ex: Vaga para motoboy com moto própria. Início imediato..."
                      />
                    </div>
                    <div className="flex items-center gap-4">
                      <button onClick={formData.editPromoNovatos ? handleEditarPromocaoNovatos : handleCriarPromocaoNovatos} disabled={loading} className={`px-6 py-2 text-white rounded-lg font-semibold disabled:opacity-50 ${formData.editPromoNovatos ? 'bg-blue-600 hover:bg-blue-700' : 'bg-green-600 hover:bg-green-700'}`}>
                        {loading ? '...' : formData.editPromoNovatos ? '💾 Salvar Alterações' : '➕ Criar Promoção'}
                      </button>
                      <p className="text-xs text-gray-500">⏱️ Inscrições expiram automaticamente em 10 dias</p>
                    </div>
                  </div>

                  {/* Promoções Novatos Cadastradas */}
                  <div className="bg-white rounded-xl shadow p-6 mb-6">
                    <h3 className="font-semibold mb-4">📋 Promoções Novatos Cadastradas</h3>
                    {promocoesNovatos.length === 0 ? (
                      <p className="text-gray-500 text-center py-4">Nenhuma promoção cadastrada</p>
                    ) : (
                      <div className="grid md:grid-cols-3 gap-3">
                        {promocoesNovatos.map(p => (
                          <div key={p.id} className={`border rounded-lg p-3 ${p.status === 'ativa' ? 'border-green-300 bg-green-50' : 'border-gray-300 bg-gray-50'}`}>
                            <div className="flex justify-between items-center mb-1">
                              <span className={`px-2 py-0.5 rounded text-xs font-bold ${p.status === 'ativa' ? 'bg-green-500 text-white' : 'bg-gray-500 text-white'}`}>
                                {p.status === 'ativa' ? '✅' : '⏸️'}
                              </span>
                              <div className="flex gap-1">
                                <button 
                                  onClick={() => setFormData({...formData, editPromoNovatos: p, novatosRegiao: p.regiao, novatosCliente: p.cliente, novatosValor: p.valor_bonus, novatosDetalhes: p.detalhes || ''})}
                                  className="text-xs text-blue-500 hover:text-blue-700"
                                  title="Editar"
                                >✏️</button>
                                <button 
                                  onClick={async () => {
                                    await fetch(`${API_URL}/promocoes-novatos/${p.id}`, {
                                      method: 'PATCH',
                                      headers: { 'Content-Type': 'application/json' },
                                      body: JSON.stringify({ status: p.status === 'ativa' ? 'inativa' : 'ativa' })
                                    });
                                    loadPromocoesNovatos();
                                  }}
                                  className="text-xs text-gray-500 hover:text-gray-700"
                                  title={p.status === 'ativa' ? 'Desativar' : 'Ativar'}
                                >
                                  {p.status === 'ativa' ? '⏸️' : '▶️'}
                                </button>
                                <button 
                                  onClick={() => handleExcluirPromocaoNovatos(p.id)}
                                  className="text-xs text-red-500 hover:text-red-700"
                                  title="Excluir"
                                >🗑️</button>
                              </div>
                            </div>
                            <p className="font-semibold text-sm">📍 {p.regiao}</p>
                            <p className="text-sm text-gray-700">🏢 {p.cliente}</p>
                            <p className="text-lg font-bold text-green-600">{formatMoney(p.valor_bonus)}</p>
                            {p.detalhes && (
                              <p className="text-xs text-gray-600 mt-1 whitespace-pre-wrap line-clamp-2" title={p.detalhes}>{p.detalhes}</p>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Cards de estatísticas */}
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
                    <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-4 text-center">
                      <p className="text-3xl font-bold text-yellow-600">{inscricoesNovatos.filter(i => i.status === 'pendente').length}</p>
                      <p className="text-sm text-yellow-700">Pendentes</p>
                    </div>
                    <div className="bg-green-50 border border-green-200 rounded-xl p-4 text-center">
                      <p className="text-3xl font-bold text-green-600">{inscricoesNovatos.filter(i => i.status === 'aprovada').length}</p>
                      <p className="text-sm text-green-700">Aprovadas</p>
                    </div>
                    <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-center">
                      <p className="text-3xl font-bold text-red-600">{inscricoesNovatos.filter(i => i.status === 'rejeitada').length}</p>
                      <p className="text-sm text-red-700">Rejeitadas</p>
                    </div>
                    <div className="bg-gray-50 border border-gray-200 rounded-xl p-4 text-center">
                      <p className="text-3xl font-bold text-gray-600">{inscricoesNovatos.filter(i => i.status === 'expirada').length}</p>
                      <p className="text-sm text-gray-700">Expiradas</p>
                    </div>
                  </div>

                  {/* Tabela de Inscrições */}
                  <div className="bg-white rounded-xl shadow p-6">
                    <h3 className="font-semibold mb-4">🚀 Inscrições de Novatos</h3>
                    {inscricoesNovatos.length === 0 ? (
                      <p className="text-gray-500 text-center py-8">Nenhuma inscrição recebida</p>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead className="bg-gray-50">
                            <tr>
                              <th className="px-2 py-3 text-left text-xs">Data</th>
                              <th className="px-2 py-3 text-left text-xs">Profissional</th>
                              <th className="px-2 py-3 text-left text-xs">COD</th>
                              <th className="px-2 py-3 text-left text-xs">Região</th>
                              <th className="px-2 py-3 text-left text-xs">Cliente</th>
                              <th className="px-2 py-3 text-center text-xs">Bônus</th>
                              <th className="px-2 py-3 text-center text-xs">Expira</th>
                              <th className="px-2 py-3 text-center text-xs">Crédito</th>
                              <th className="px-3 py-3 text-center">Status</th>
                              <th className="px-2 py-3 text-center text-xs">Admin</th>
                              <th className="px-2 py-3 text-center text-xs">Ações</th>
                            </tr>
                          </thead>
                          <tbody>
                            {inscricoesNovatos.map(i => {
                              const dataExpira = i.expires_at ? new Date(i.expires_at) : null;
                              const expirado = dataExpira && new Date() > dataExpira;
                              return (
                                <tr key={i.id} className={`border-b ${i.status === 'aprovada' ? 'bg-green-50' : i.status === 'rejeitada' ? 'bg-red-50' : expirado && i.status === 'pendente' ? 'bg-gray-100' : ''}`}>
                                  <td className="px-2 py-3 text-xs">{new Date(i.created_at).toLocaleDateString('pt-BR')}</td>
                                  <td className="px-2 py-3 text-xs font-medium">{i.user_name}</td>
                                  <td className="px-2 py-3 text-xs">{i.user_cod}</td>
                                  <td className="px-2 py-3 text-xs">{i.regiao}</td>
                                  <td className="px-2 py-3 text-xs">{i.cliente}</td>
                                  <td className="px-2 py-3 text-center text-xs font-bold text-green-600">{formatMoney(i.valor_bonus)}</td>
                                  <td className="px-2 py-3 text-center text-xs">
                                    {dataExpira ? (
                                      <span className={expirado ? 'text-red-500' : 'text-gray-600'}>
                                        {dataExpira.toLocaleDateString('pt-BR')}
                                      </span>
                                    ) : '-'}
                                  </td>
                                  <td className="px-2 py-3 text-center">
                                    {i.status === 'aprovada' ? (
                                      i.credito_lancado ? (
                                        <div>
                                          <span className="text-xs text-green-600 font-bold">✅ Lançado</span>
                                          {i.lancado_por && <p className="text-xs text-gray-400">{i.lancado_por}</p>}
                                        </div>
                                      ) : (
                                        <button 
                                          onClick={() => handleCreditarBonusNovatos(i)}
                                          className="px-2 py-1 bg-blue-500 text-white text-xs rounded hover:bg-blue-600"
                                          disabled={loading}
                                        >
                                          💰 Lançar
                                        </button>
                                      )
                                    ) : '-'}
                                  </td>
                                  <td className="px-3 py-3 text-center">
                                    <span className={`px-2 py-1 rounded-full text-xs font-bold ${
                                      i.status === 'pendente' ? (expirado ? 'bg-gray-200 text-gray-700' : 'bg-yellow-100 text-yellow-700') :
                                      i.status === 'aprovada' ? 'bg-green-100 text-green-700' :
                                      i.status === 'rejeitada' ? 'bg-red-100 text-red-700' :
                                      'bg-gray-100 text-gray-700'
                                    }`}>
                                      {i.status === 'pendente' && expirado ? '⏰ Expirada' : 
                                       i.status === 'pendente' ? '⏳ Pendente' : 
                                       i.status === 'aprovada' ? '✅ Aprovada' : 
                                       i.status === 'rejeitada' ? '❌ Rejeitada' : i.status}
                                    </span>
                                  </td>
                                  <td className="px-2 py-3 text-center text-xs text-gray-500">
                                    {i.resolved_by || '-'}
                                  </td>
                                  <td className="px-2 py-3 text-center">
                                    {i.status === 'pendente' && !expirado && (
                                      <div className="flex gap-1 justify-center">
                                        <button onClick={() => handleAprovarInscricaoNovatos(i.id)} className="p-1 bg-green-500 text-white rounded text-xs hover:bg-green-600" disabled={loading}>✓</button>
                                        <button onClick={() => setFormData({...formData, modalRejeitarNovatos: i})} className="p-1 bg-red-500 text-white rounded text-xs hover:bg-red-600">✗</button>
                                      </div>
                                    )}
                                    {i.status === 'rejeitada' && i.motivo_rejeicao && (
                                      <span className="text-xs text-red-500" title={i.motivo_rejeicao}>📝</span>
                                    )}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                </>
              )}


              {/* ========== ABA RELATÓRIOS ========== */}
              {formData.finTab === 'relatorios' && (
                <>
                  {(() => {
                    const now = new Date();
                    const mesAtual = now.getMonth();
                    const anoAtual = now.getFullYear();
                    
                    // Período selecionado
                    const mesSelecionado = formData.relMes !== undefined ? parseInt(formData.relMes) : mesAtual;
                    const anoSelecionado = formData.relAno !== undefined ? parseInt(formData.relAno) : anoAtual;
                    
                    // Filtrar saques do período
                    const saquesDoMes = allWithdrawals.filter(w => {
                      const d = new Date(w.created_at);
                      return d.getMonth() === mesSelecionado && d.getFullYear() === anoSelecionado;
                    });
                    
                    const aprovados = saquesDoMes.filter(w => w.status === 'aprovado' || w.status === 'aprovado_gratuidade');
                    const aprovadosSemGrat = saquesDoMes.filter(w => w.status === 'aprovado');
                    const aprovadosComGrat = saquesDoMes.filter(w => w.status === 'aprovado_gratuidade');
                    const rejeitados = saquesDoMes.filter(w => w.status === 'rejeitado');
                    const pendentes = saquesDoMes.filter(w => w.status === 'aguardando_aprovacao');
                    
                    const totalSolicitado = saquesDoMes.reduce((acc, w) => acc + parseFloat(w.requested_amount || 0), 0);
                    const totalPago = aprovados.reduce((acc, w) => acc + parseFloat(w.final_amount || 0), 0);
                    const lucroTaxas = aprovadosSemGrat.reduce((acc, w) => acc + (parseFloat(w.requested_amount || 0) - parseFloat(w.final_amount || 0)), 0);
                    const deixouArrecadar = aprovadosComGrat.reduce((acc, w) => acc + (parseFloat(w.requested_amount || 0) * 0.045), 0);
                    
                    // Dados por semana
                    const semanas = [
                      { nome: 'Semana 1', dias: [1,7] },
                      { nome: 'Semana 2', dias: [8,14] },
                      { nome: 'Semana 3', dias: [15,21] },
                      { nome: 'Semana 4', dias: [22,31] }
                    ];
                    
                    const dadosSemanas = semanas.map(s => {
                      const saquesSemana = aprovados.filter(w => {
                        const dia = new Date(w.created_at).getDate();
                        return dia >= s.dias[0] && dia <= s.dias[1];
                      });
                      return {
                        nome: s.nome,
                        valor: saquesSemana.reduce((acc, w) => acc + parseFloat(w.final_amount || 0), 0),
                        qtd: saquesSemana.length
                      };
                    });
                    const maxSemana = Math.max(...dadosSemanas.map(s => s.valor), 1);
                    
                    // Comparativo mês anterior
                    const mesAnterior = mesSelecionado === 0 ? 11 : mesSelecionado - 1;
                    const anoMesAnterior = mesSelecionado === 0 ? anoSelecionado - 1 : anoSelecionado;
                    const saquesMesAnterior = allWithdrawals.filter(w => {
                      const d = new Date(w.created_at);
                      return d.getMonth() === mesAnterior && d.getFullYear() === anoMesAnterior && (w.status === 'aprovado' || w.status === 'aprovado_gratuidade');
                    });
                    const totalMesAnterior = saquesMesAnterior.reduce((acc, w) => acc + parseFloat(w.final_amount || 0), 0);
                    const variacaoPercent = totalMesAnterior > 0 ? ((totalPago - totalMesAnterior) / totalMesAnterior * 100) : 0;
                    
                    // Últimos 6 meses para gráfico
                    const ultimos6Meses = [];
                    for (let i = 5; i >= 0; i--) {
                      const d = new Date(anoSelecionado, mesSelecionado - i, 1);
                      const mes = d.getMonth();
                      const ano = d.getFullYear();
                      const saquesMes = allWithdrawals.filter(w => {
                        const dw = new Date(w.created_at);
                        return dw.getMonth() === mes && dw.getFullYear() === ano && (w.status === 'aprovado' || w.status === 'aprovado_gratuidade');
                      });
                      const valor = saquesMes.reduce((acc, w) => acc + parseFloat(w.final_amount || 0), 0);
                      ultimos6Meses.push({
                        mes: d.toLocaleDateString('pt-BR', { month: 'short' }).replace('.', ''),
                        valor,
                        qtd: saquesMes.length
                      });
                    }
                    const maxValor6 = Math.max(...ultimos6Meses.map(m => m.valor), 1);
                    
                    const meses = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
                    const nomeMes = meses[mesSelecionado];
                    
                    // Função gerar PDF
                    const gerarPDF = () => {
                      const conteudo = `
                        <html>
                        <head>
                          <title>Relatório ${nomeMes} ${anoSelecionado}</title>
                          <style>
                            body { font-family: Arial, sans-serif; padding: 40px; font-size: 12px; }
                            h1 { color: #166534; border-bottom: 3px solid #166534; padding-bottom: 10px; }
                            h2 { color: #374151; margin-top: 25px; border-bottom: 1px solid #e5e7eb; padding-bottom: 5px; }
                            .header { display: flex; justify-content: space-between; margin-bottom: 20px; }
                            .cards { display: grid; grid-template-columns: repeat(4, 1fr); gap: 15px; margin: 20px 0; }
                            .card { background: #f3f4f6; padding: 15px; border-radius: 8px; text-align: center; }
                            .card-value { font-size: 20px; font-weight: bold; color: #166534; }
                            .card-label { font-size: 11px; color: #6b7280; }
                            table { width: 100%; border-collapse: collapse; margin-top: 15px; font-size: 11px; }
                            th, td { border: 1px solid #d1d5db; padding: 8px; text-align: left; }
                            th { background: #166534; color: white; }
                            tr:nth-child(even) { background: #f9fafb; }
                            .green { color: #059669; }
                            .red { color: #dc2626; }
                            .footer { margin-top: 30px; text-align: center; color: #9ca3af; font-size: 10px; border-top: 1px solid #e5e7eb; padding-top: 15px; }
                            .stats-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 15px; margin: 15px 0; }
                            .stat-box { background: #ecfdf5; padding: 12px; border-radius: 8px; border-left: 4px solid #059669; }
                            .stat-box.red { background: #fef2f2; border-left-color: #dc2626; }
                          </style>
                        </head>
                        <body>
                          <div class="header">
                            <div><h1>📊 Relatório Financeiro - ${nomeMes} ${anoSelecionado}</h1></div>
                          </div>
                          <p><strong>Gerado em:</strong> ${new Date().toLocaleString('pt-BR')}</p>
                          
                          <h2>📈 Resumo do Período</h2>
                          <div class="cards">
                            <div class="card"><div class="card-value">R$ ${totalSolicitado.toFixed(2)}</div><div class="card-label">Total Solicitado</div></div>
                            <div class="card"><div class="card-value">R$ ${totalPago.toFixed(2)}</div><div class="card-label">Total Pago</div></div>
                            <div class="card"><div class="card-value" style="color:#059669">R$ ${lucroTaxas.toFixed(2)}</div><div class="card-label">Lucro (Taxas 4,5%)</div></div>
                            <div class="card"><div class="card-value" style="color:#dc2626">R$ ${deixouArrecadar.toFixed(2)}</div><div class="card-label">Deixou Arrecadar</div></div>
                          </div>
                          
                          <div class="stats-row">
                            <div class="stat-box"><strong>${aprovados.length}</strong> Aprovados</div>
                            <div class="stat-box"><strong>${aprovadosSemGrat.length}</strong> Sem Gratuidade</div>
                            <div class="stat-box"><strong>${aprovadosComGrat.length}</strong> Com Gratuidade</div>
                          </div>
                          <div class="stats-row">
                            <div class="stat-box red"><strong>${rejeitados.length}</strong> Rejeitados</div>
                            <div class="stat-box"><strong>${pendentes.length}</strong> Pendentes</div>
                            <div class="stat-box"><strong>${saquesDoMes.length}</strong> Total Solicitações</div>
                          </div>
                          
                          <h2>📊 Comparativo</h2>
                          <p>Mês anterior: <strong>R$ ${totalMesAnterior.toFixed(2)}</strong> | Mês atual: <strong>R$ ${totalPago.toFixed(2)}</strong> | Variação: <span class="${variacaoPercent >= 0 ? 'green' : 'red'}"><strong>${variacaoPercent >= 0 ? '+' : ''}${variacaoPercent.toFixed(1)}%</strong></span></p>
                          
                          <h2>📋 Detalhamento das Solicitações</h2>
                          <table>
                            <thead><tr><th>Data</th><th>Profissional</th><th>Código</th><th>Solicitado</th><th>Pago</th><th>Status</th></tr></thead>
                            <tbody>
                              ${saquesDoMes.map(w => `
                                <tr>
                                  <td>${new Date(w.created_at).toLocaleDateString('pt-BR')}</td>
                                  <td>${w.user_name || '-'}</td>
                                  <td>${w.user_cod}</td>
                                  <td>R$ ${parseFloat(w.requested_amount).toFixed(2)}</td>
                                  <td>R$ ${parseFloat(w.final_amount).toFixed(2)}</td>
                                  <td>${w.status === 'aprovado' ? '✅ Aprovado' : w.status === 'aprovado_gratuidade' ? '🎁 c/ Gratuidade' : w.status === 'rejeitado' ? '❌ Rejeitado' : '⏳ Pendente'}</td>
                                </tr>
                              `).join('')}
                            </tbody>
                          </table>
                          
                          <div class="footer">
                            <p>Sistema Tutts - Relatório Financeiro Gerado Automaticamente</p>
                          </div>
                        </body>
                        </html>
                      `;
                      const janela = window.open('', '_blank');
                      janela.document.write(conteudo);
                      janela.document.close();
                      janela.print();
                    };
                    
                    return (
                      <div className="space-y-6">
                        {/* Seletor de Período e Botões */}
                        <div className="bg-white rounded-xl shadow p-4">
                          <div className="flex flex-wrap gap-4 items-end">
                            <div>
                              <label className="block text-sm font-semibold mb-1">Mês</label>
                              <select value={mesSelecionado} onChange={e => setFormData({...formData, relMes: e.target.value})} className="px-4 py-2 border rounded-lg">
                                {meses.map((m, i) => <option key={i} value={i}>{m}</option>)}
                              </select>
                            </div>
                            <div>
                              <label className="block text-sm font-semibold mb-1">Ano</label>
                              <select value={anoSelecionado} onChange={e => setFormData({...formData, relAno: e.target.value})} className="px-4 py-2 border rounded-lg">
                                {[anoAtual - 1, anoAtual, anoAtual + 1].map(a => <option key={a} value={a}>{a}</option>)}
                              </select>
                            </div>
                            <button onClick={gerarPDF} className="px-6 py-2 bg-red-600 text-white rounded-lg font-semibold hover:bg-red-700">
                              📄 Gerar PDF
                            </button>
                          </div>
                        </div>
                        
                        {/* Cards Resumo */}
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                          <div className="bg-white rounded-xl shadow p-4 border-l-4 border-blue-500">
                            <p className="text-xs text-gray-500">💰 Total Solicitado</p>
                            <p className="text-2xl font-bold text-blue-600">{formatMoney(totalSolicitado)}</p>
                          </div>
                          <div className="bg-white rounded-xl shadow p-4 border-l-4 border-purple-500">
                            <p className="text-xs text-gray-500">💵 Total Pago</p>
                            <p className="text-2xl font-bold text-purple-600">{formatMoney(totalPago)}</p>
                          </div>
                          <div className="bg-white rounded-xl shadow p-4 border-l-4 border-green-500">
                            <p className="text-xs text-gray-500">📈 Lucro (Taxas)</p>
                            <p className="text-2xl font-bold text-green-600">{formatMoney(lucroTaxas)}</p>
                          </div>
                          <div className="bg-white rounded-xl shadow p-4 border-l-4 border-red-500">
                            <p className="text-xs text-gray-500">📉 Deixou Arrecadar</p>
                            <p className="text-2xl font-bold text-red-600">{formatMoney(deixouArrecadar)}</p>
                          </div>
                        </div>
                        
                        {/* Comparativo */}
                        <div className={`rounded-xl p-4 ${variacaoPercent >= 0 ? 'bg-green-50 border border-green-200' : 'bg-red-50 border border-red-200'}`}>
                          <h3 className="font-semibold mb-2">📊 Comparativo com Mês Anterior</h3>
                          <div className="flex items-center gap-6">
                            <div>
                              <p className="text-sm text-gray-600">Mês anterior: <strong>{formatMoney(totalMesAnterior)}</strong></p>
                              <p className="text-sm text-gray-600">Mês atual: <strong>{formatMoney(totalPago)}</strong></p>
                            </div>
                            <div className={`text-3xl font-bold ${variacaoPercent >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                              {variacaoPercent >= 0 ? '📈' : '📉'} {variacaoPercent >= 0 ? '+' : ''}{variacaoPercent.toFixed(1)}%
                            </div>
                          </div>
                        </div>
                        
                        {/* Status */}
                        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
                          <div className="bg-green-100 rounded-xl p-4 text-center">
                            <p className="text-3xl font-bold text-green-600">{aprovados.length}</p>
                            <p className="text-xs text-green-700">Aprovados</p>
                          </div>
                          <div className="bg-blue-100 rounded-xl p-4 text-center">
                            <p className="text-3xl font-bold text-blue-600">{aprovadosSemGrat.length}</p>
                            <p className="text-xs text-blue-700">Sem Gratuidade</p>
                          </div>
                          <div className="bg-purple-100 rounded-xl p-4 text-center">
                            <p className="text-3xl font-bold text-purple-600">{aprovadosComGrat.length}</p>
                            <p className="text-xs text-purple-700">Com Gratuidade</p>
                          </div>
                          <div className="bg-red-100 rounded-xl p-4 text-center">
                            <p className="text-3xl font-bold text-red-600">{rejeitados.length}</p>
                            <p className="text-xs text-red-700">Rejeitados</p>
                          </div>
                          <div className="bg-yellow-100 rounded-xl p-4 text-center">
                            <p className="text-3xl font-bold text-yellow-600">{pendentes.length}</p>
                            <p className="text-xs text-yellow-700">Pendentes</p>
                          </div>
                        </div>
                        
                        {/* Gráfico Evolução 6 meses */}
                        <div className="bg-white rounded-xl shadow p-4">
                          <h3 className="font-semibold mb-4">📊 Evolução (Últimos 6 meses)</h3>
                          <div className="flex items-end justify-between gap-2 h-48">
                            {ultimos6Meses.map((m, i) => (
                              <div key={i} className="flex-1 flex flex-col items-center">
                                <span className="text-xs text-gray-600 mb-1">{formatMoney(m.valor)}</span>
                                <div 
                                  className="w-full bg-gradient-to-t from-green-600 to-emerald-400 rounded-t-lg"
                                  style={{ height: `${Math.max((m.valor / maxValor6) * 100, 5)}%`, minHeight: '20px' }}
                                />
                                <span className="text-xs font-semibold mt-2">{m.mes}</span>
                                <span className="text-xs text-gray-500">{m.qtd}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                        
                        {/* Gráfico por Semana */}
                        <div className="bg-white rounded-xl shadow p-4">
                          <h3 className="font-semibold mb-4">📅 Distribuição por Semana ({nomeMes})</h3>
                          <div className="flex items-end justify-between gap-4 h-40">
                            {dadosSemanas.map((s, i) => (
                              <div key={i} className="flex-1 flex flex-col items-center">
                                <span className="text-xs text-gray-600 mb-1">{formatMoney(s.valor)}</span>
                                <div 
                                  className="w-full bg-gradient-to-t from-blue-600 to-indigo-400 rounded-t-lg"
                                  style={{ height: `${Math.max((s.valor / maxSemana) * 100, 5)}%`, minHeight: '20px' }}
                                />
                                <span className="text-xs font-semibold mt-2">{s.nome}</span>
                                <span className="text-xs text-gray-500">{s.qtd} saque(s)</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    );
                  })()}
                </>
              )}

              {/* ========== ABA HORÁRIOS DE ATENDIMENTO ========== */}
              {formData.finTab === 'horarios' && (
                <>
                  {horariosData.loading ? (
                    <div className="flex items-center justify-center py-12">
                      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-green-600"></div>
                      <span className="ml-3">Carregando...</span>
                    </div>
                  ) : (
                    <div className="space-y-6">
                      {/* Horários Normais */}
                      <div className="bg-white rounded-xl shadow p-4">
                        <h3 className="font-bold text-gray-800 mb-4">🕐 Horários de Atendimento</h3>
                        <p className="text-sm text-gray-600 mb-4">Configure os horários de funcionamento para cada dia da semana.</p>
                        
                        <div className="space-y-2">
                          {horariosData.horarios.map(h => (
                            <div key={h.id} className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg">
                              <div className="w-32 font-semibold text-sm">{diasSemana[h.dia_semana]}</div>
                              <label className="flex items-center gap-2">
                                <input 
                                  type="checkbox" 
                                  checked={h.ativo} 
                                  onChange={e => atualizarHorario(h.id, {...h, ativo: e.target.checked})}
                                  className="w-4 h-4"
                                />
                                <span className="text-sm">Aberto</span>
                              </label>
                              {h.ativo && (
                                <>
                                  <input 
                                    type="time" 
                                    value={h.hora_inicio || '09:00'}
                                    onChange={e => atualizarHorario(h.id, {...h, hora_inicio: e.target.value})}
                                    className="px-2 py-1 border rounded text-sm"
                                  />
                                  <span className="text-gray-500">às</span>
                                  <input 
                                    type="time" 
                                    value={h.hora_fim || '18:00'}
                                    onChange={e => atualizarHorario(h.id, {...h, hora_fim: e.target.value})}
                                    className="px-2 py-1 border rounded text-sm"
                                  />
                                </>
                              )}
                              {!h.ativo && <span className="text-red-500 text-sm font-semibold">FECHADO</span>}
                            </div>
                          ))}
                        </div>
                      </div>
                      
                      {/* Horários Especiais */}
                      <div className="bg-white rounded-xl shadow p-4">
                        <h3 className="font-bold text-gray-800 mb-4">📅 Horários Especiais (Feriados, Datas específicas)</h3>
                        
                        {/* Formulário novo especial */}
                        <div className="bg-blue-50 p-4 rounded-lg mb-4">
                          <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
                            <input 
                              type="date" 
                              value={formData.novoEspData || ''}
                              onChange={e => setFormData(f => ({...f, novoEspData: e.target.value}))}
                              className="px-3 py-2 border rounded text-sm"
                            />
                            <input 
                              type="text" 
                              placeholder="Descrição (ex: Feriado)"
                              value={formData.novoEspDesc || ''}
                              onChange={e => setFormData(f => ({...f, novoEspDesc: e.target.value}))}
                              className="px-3 py-2 border rounded text-sm"
                            />
                            <label className="flex items-center gap-2">
                              <input 
                                type="checkbox" 
                                checked={formData.novoEspFechado || false}
                                onChange={e => setFormData(f => ({...f, novoEspFechado: e.target.checked}))}
                                className="w-4 h-4"
                              />
                              <span className="text-sm">Fechado</span>
                            </label>
                            {!formData.novoEspFechado && (
                              <div className="flex items-center gap-2">
                                <input 
                                  type="time" 
                                  value={formData.novoEspInicio || '09:00'}
                                  onChange={e => setFormData(f => ({...f, novoEspInicio: e.target.value}))}
                                  className="px-2 py-1 border rounded text-sm w-24"
                                />
                                <span>às</span>
                                <input 
                                  type="time" 
                                  value={formData.novoEspFim || '18:00'}
                                  onChange={e => setFormData(f => ({...f, novoEspFim: e.target.value}))}
                                  className="px-2 py-1 border rounded text-sm w-24"
                                />
                              </div>
                            )}
                            <button 
                              onClick={criarEspecial}
                              className="px-4 py-2 bg-blue-600 text-white rounded font-semibold text-sm hover:bg-blue-700"
                            >
                              + Adicionar
                            </button>
                          </div>
                        </div>
                        
                        {/* Lista de especiais */}
                        {horariosData.especiais.length === 0 ? (
                          <p className="text-gray-500 text-sm">Nenhum horário especial programado.</p>
                        ) : (
                          <div className="space-y-2">
                            {horariosData.especiais.map(esp => (
                              <div key={esp.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                                <div className="flex items-center gap-4">
                                  <span className="font-mono font-bold text-purple-600">
                                    {new Date(esp.data + 'T12:00:00').toLocaleDateString('pt-BR')}
                                  </span>
                                  <span className="text-sm text-gray-700">{esp.descricao}</span>
                                  {esp.fechado ? (
                                    <span className="px-2 py-0.5 bg-red-500 text-white text-xs rounded font-bold">FECHADO</span>
                                  ) : (
                                    <span className="text-sm text-green-600 font-semibold">
                                      {esp.hora_inicio} às {esp.hora_fim}
                                    </span>
                                  )}
                                </div>
                                <button 
                                  onClick={() => removerEspecial(esp.id)}
                                  className="px-2 py-1 bg-red-500 text-white rounded text-xs hover:bg-red-600"
                                >
                                  🗑️ Remover
                                </button>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </>
              )}

              {/* ========== ABA AVISOS ========== */}
              {formData.finTab === 'avisos' && (
                <>
                  {avisosData.loading ? (
                    <div className="flex items-center justify-center py-12">
                      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-yellow-600"></div>
                      <span className="ml-3">Carregando...</span>
                    </div>
                  ) : (
                    <div className="space-y-6">
                      {/* Criar Novo Aviso */}
                      <div className="bg-white rounded-xl shadow p-4">
                        <h3 className="font-bold text-gray-800 mb-4">📢 Criar Novo Aviso</h3>
                        <p className="text-sm text-gray-600 mb-4">
                          Os avisos criados aqui serão exibidos para os usuários na tela de Saque Emergencial.
                        </p>
                        
                        <div className="bg-yellow-50 p-4 rounded-lg">
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
                            <input 
                              type="text" 
                              placeholder="Título do aviso"
                              value={formData.novoAvisoTitulo || ''}
                              onChange={e => setFormData(f => ({...f, novoAvisoTitulo: e.target.value}))}
                              className="px-3 py-2 border rounded text-sm"
                            />
                            <select
                              value={formData.novoAvisoTipo || 'info'}
                              onChange={e => setFormData(f => ({...f, novoAvisoTipo: e.target.value}))}
                              className="px-3 py-2 border rounded text-sm"
                            >
                              <option value="info">ℹ️ Informativo (Azul)</option>
                              <option value="warning">⚠️ Atenção (Amarelo)</option>
                              <option value="error">🚨 Urgente (Vermelho)</option>
                              <option value="success">✅ Positivo (Verde)</option>
                            </select>
                          </div>
                          <textarea 
                            placeholder="Mensagem do aviso..."
                            value={formData.novoAvisoMensagem || ''}
                            onChange={e => setFormData(f => ({...f, novoAvisoMensagem: e.target.value}))}
                            className="w-full px-3 py-2 border rounded text-sm mb-3"
                            rows={3}
                          />
                          <div className="flex items-center justify-between flex-wrap gap-3">
                            <label className="flex items-center gap-2">
                              <input 
                                type="checkbox" 
                                checked={formData.novoAvisoExibirFora || false}
                                onChange={e => setFormData(f => ({...f, novoAvisoExibirFora: e.target.checked}))}
                                className="w-4 h-4"
                              />
                              <span className="text-sm">Exibir apenas fora do horário de atendimento</span>
                            </label>
                            <button 
                              onClick={criarAviso}
                              className="px-6 py-2 bg-yellow-500 text-white rounded-lg font-semibold text-sm hover:bg-yellow-600"
                            >
                              + Criar Aviso
                            </button>
                          </div>
                        </div>
                      </div>
                      
                      {/* Avisos Ativos */}
                      <div className="bg-white rounded-xl shadow p-4">
                        <h3 className="font-bold text-gray-800 mb-4">
                          ✅ Avisos Ativos ({avisosData.avisos.filter(a => a.ativo).length})
                        </h3>
                        
                        {avisosData.avisos.filter(a => a.ativo).length === 0 ? (
                          <div className="text-center py-8 text-gray-500">
                            <p className="text-4xl mb-2">📭</p>
                            <p>Nenhum aviso ativo no momento.</p>
                          </div>
                        ) : (
                          <div className="space-y-3">
                            {avisosData.avisos.filter(a => a.ativo).map(av => (
                              <div key={av.id} className={`p-4 rounded-lg border-l-4 ${
                                av.tipo === 'error' ? 'bg-red-50 border-red-500' :
                                av.tipo === 'warning' ? 'bg-yellow-50 border-yellow-500' :
                                av.tipo === 'success' ? 'bg-green-50 border-green-500' :
                                'bg-blue-50 border-blue-500'
                              }`}>
                                <div className="flex items-start justify-between gap-4">
                                  <div className="flex-1">
                                    <div className="flex items-center gap-2 mb-2">
                                      <span className="text-lg">
                                        {av.tipo === 'error' ? '🚨' : av.tipo === 'warning' ? '⚠️' : av.tipo === 'success' ? '✅' : 'ℹ️'}
                                      </span>
                                      <span className="font-bold">{av.titulo}</span>
                                      {av.exibir_fora_horario && (
                                        <span className="px-2 py-0.5 bg-orange-200 text-orange-700 text-[10px] rounded-full font-semibold">
                                          🕐 Só fora do horário
                                        </span>
                                      )}
                                    </div>
                                    <p className="text-sm text-gray-700">{av.mensagem}</p>
                                    <p className="text-xs text-gray-400 mt-2">
                                      Criado em: {new Date(av.created_at).toLocaleString('pt-BR')}
                                    </p>
                                  </div>
                                  <div className="flex flex-col gap-2">
                                    <button 
                                      onClick={() => toggleAviso(av)}
                                      className="px-3 py-1.5 bg-gray-500 text-white rounded text-xs font-bold hover:bg-gray-600"
                                    >
                                      ⏸️ Desativar
                                    </button>
                                    <button 
                                      onClick={() => removerAviso(av.id)}
                                      className="px-3 py-1.5 bg-red-500 text-white rounded text-xs font-bold hover:bg-red-600"
                                    >
                                      🗑️ Excluir
                                    </button>
                                  </div>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                      
                      {/* Histórico de Avisos (Inativos) */}
                      <div className="bg-white rounded-xl shadow p-4">
                        <h3 className="font-bold text-gray-800 mb-4">
                          📜 Histórico de Avisos ({avisosData.avisos.filter(a => !a.ativo).length})
                        </h3>
                        
                        {avisosData.avisos.filter(a => !a.ativo).length === 0 ? (
                          <div className="text-center py-6 text-gray-400">
                            <p className="text-sm">Nenhum aviso no histórico.</p>
                          </div>
                        ) : (
                          <div className="space-y-2">
                            {avisosData.avisos.filter(a => !a.ativo).map(av => (
                              <div key={av.id} className="p-3 rounded-lg bg-gray-100 border border-gray-200 opacity-70">
                                <div className="flex items-start justify-between gap-4">
                                  <div className="flex-1">
                                    <div className="flex items-center gap-2 mb-1">
                                      <span className="text-sm">
                                        {av.tipo === 'error' ? '🚨' : av.tipo === 'warning' ? '⚠️' : av.tipo === 'success' ? '✅' : 'ℹ️'}
                                      </span>
                                      <span className="font-semibold text-sm text-gray-600">{av.titulo}</span>
                                      <span className="px-1.5 py-0.5 bg-gray-400 text-white text-[10px] rounded">INATIVO</span>
                                    </div>
                                    <p className="text-xs text-gray-500">{av.mensagem}</p>
                                    <p className="text-[10px] text-gray-400 mt-1">
                                      Criado: {new Date(av.created_at).toLocaleString('pt-BR')}
                                    </p>
                                  </div>
                                  <div className="flex gap-2">
                                    <button 
                                      onClick={() => toggleAviso(av)}
                                      className="px-2 py-1 bg-green-500 text-white rounded text-xs font-bold hover:bg-green-600"
                                    >
                                      ▶️ Ativar
                                    </button>
                                    <button 
                                      onClick={() => removerAviso(av.id)}
                                      className="px-2 py-1 bg-red-500 text-white rounded text-xs font-bold hover:bg-red-600"
                                    >
                                      🗑️
                                    </button>
                                  </div>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </>
              )}

              {/* ========== ABA BACKUP ========== */}
              {formData.finTab === 'backup' && (
                <>
                  {(() => {
                    // Função para exportar dados como JSON
                    const exportarJSON = (dados, nomeArquivo) => {
                      const json = JSON.stringify(dados, null, 2);
                      const blob = new Blob([json], { type: 'application/json' });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement('a');
                      a.href = url;
                      a.download = nomeArquivo;
                      a.click();
                      URL.revokeObjectURL(url);
                      showToast(`✅ ${nomeArquivo} exportado com sucesso!`, 'success');
                    };

                    // Função para exportar como CSV
                    const exportarCSV = (dados, colunas, nomeArquivo) => {
                      const header = colunas.map(c => c.label).join(';');
                      const rows = dados.map(item => 
                        colunas.map(c => {
                          let val = item[c.key] || '';
                          if (typeof val === 'string' && val.includes(';')) val = `"${val}"`;
                          return val;
                        }).join(';')
                      );
                      const csv = [header, ...rows].join('\n');
                      const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement('a');
                      a.href = url;
                      a.download = nomeArquivo;
                      a.click();
                      URL.revokeObjectURL(url);
                      showToast(`✅ ${nomeArquivo} exportado com sucesso!`, 'success');
                    };

                    const dataAtual = new Date().toISOString().split('T')[0];

                    // Definição das colunas para cada tipo de dado
                    const colunasWithdrawals = [
                      { key: 'id', label: 'ID' },
                      { key: 'user_cod', label: 'Código' },
                      { key: 'user_name', label: 'Nome' },
                      { key: 'cpf', label: 'CPF' },
                      { key: 'pix_key', label: 'Chave PIX' },
                      { key: 'requested_amount', label: 'Valor Solicitado' },
                      { key: 'final_amount', label: 'Valor Final' },
                      { key: 'status', label: 'Status' },
                      { key: 'reject_reason', label: 'Motivo Rejeição' },
                      { key: 'admin_name', label: 'Admin' },
                      { key: 'created_at', label: 'Data Criação' },
                      { key: 'updated_at', label: 'Data Atualização' }
                    ];

                    const colunasUsers = [
                      { key: 'id', label: 'ID' },
                      { key: 'codProfissional', label: 'Código' },
                      { key: 'fullName', label: 'Nome' },
                      { key: 'role', label: 'Tipo' },
                      { key: 'createdAt', label: 'Data Cadastro' }
                    ];

                    const colunasGratuities = [
                      { key: 'id', label: 'ID' },
                      { key: 'user_cod', label: 'Código' },
                      { key: 'user_name', label: 'Nome' },
                      { key: 'reason', label: 'Motivo' },
                      { key: 'created_at', label: 'Data' }
                    ];

                    const colunasRestricted = [
                      { key: 'id', label: 'ID' },
                      { key: 'user_cod', label: 'Código' },
                      { key: 'user_name', label: 'Nome' },
                      { key: 'reason', label: 'Motivo' },
                      { key: 'created_at', label: 'Data' }
                    ];

                    const colunasIndicacoes = [
                      { key: 'id', label: 'ID' },
                      { key: 'indicador_cod', label: 'Cód Indicador' },
                      { key: 'indicador_nome', label: 'Nome Indicador' },
                      { key: 'indicado_nome', label: 'Nome Indicado' },
                      { key: 'indicado_contato', label: 'Contato' },
                      { key: 'status', label: 'Status' },
                      { key: 'created_at', label: 'Data' }
                    ];

                    // Backup completo
                    const backupCompleto = {
                      data_backup: new Date().toISOString(),
                      versao: '1.0',
                      dados: {
                        withdrawals: allWithdrawals,
                        users: users,
                        gratuities: gratuities,
                        restricted: restrictedList,
                        indicacoes: indicacoes
                      },
                      estatisticas: {
                        total_withdrawals: allWithdrawals.length,
                        total_users: users.length,
                        total_gratuities: gratuities.length,
                        total_restricted: restrictedList.length,
                        total_indicacoes: indicacoes.length
                      }
                    };

                    return (
                      <div className="space-y-6">
                        {/* Header */}
                        <div className="bg-gradient-to-r from-blue-600 to-indigo-600 rounded-xl p-6 text-white">
                          <h2 className="text-2xl font-bold flex items-center gap-2">💾 Backup e Exportação de Dados</h2>
                          <p className="text-blue-100 mt-2">Exporte seus dados para manter backups seguros ou analisar em outras ferramentas.</p>
                        </div>

                        {/* Backup Completo */}
                        <div className="bg-white rounded-xl shadow p-6">
                          <div className="flex items-center justify-between">
                            <div>
                              <h3 className="text-lg font-bold text-gray-800 flex items-center gap-2">🗄️ Backup Completo</h3>
                              <p className="text-sm text-gray-600 mt-1">Exporta todos os dados do sistema em um único arquivo JSON.</p>
                              <div className="flex gap-4 mt-2 text-xs text-gray-500">
                                <span>📋 {allWithdrawals.length} solicitações</span>
                                <span>👥 {users.length} usuários</span>
                                <span>🎁 {gratuities.length} gratuidades</span>
                                <span>🚫 {restrictedList.length} restritos</span>
                                <span>🤝 {indicacoes.length} indicações</span>
                              </div>
                            </div>
                            <button 
                              onClick={() => exportarJSON(backupCompleto, `backup_completo_${dataAtual}.json`)}
                              className="px-6 py-3 bg-gradient-to-r from-blue-600 to-indigo-600 text-white rounded-lg font-semibold hover:from-blue-700 hover:to-indigo-700 flex items-center gap-2"
                            >
                              ⬇️ Baixar Backup Completo
                            </button>
                          </div>
                        </div>

                        {/* Exportações Individuais */}
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                          {/* Solicitações de Saque */}
                          <div className="bg-white rounded-xl shadow p-5">
                            <h3 className="font-bold text-gray-800 flex items-center gap-2 mb-3">📋 Solicitações de Saque</h3>
                            <p className="text-sm text-gray-600 mb-3">{allWithdrawals.length} registros</p>
                            <div className="flex gap-2">
                              <button 
                                onClick={() => exportarCSV(allWithdrawals, colunasWithdrawals, `solicitacoes_${dataAtual}.csv`)}
                                className="flex-1 px-4 py-2 bg-green-600 text-white rounded-lg font-semibold hover:bg-green-700 text-sm"
                              >
                                📊 CSV
                              </button>
                              <button 
                                onClick={() => exportarJSON(allWithdrawals, `solicitacoes_${dataAtual}.json`)}
                                className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700 text-sm"
                              >
                                📄 JSON
                              </button>
                            </div>
                          </div>

                          {/* Usuários */}
                          <div className="bg-white rounded-xl shadow p-5">
                            <h3 className="font-bold text-gray-800 flex items-center gap-2 mb-3">👥 Usuários</h3>
                            <p className="text-sm text-gray-600 mb-3">{users.length} registros</p>
                            <div className="flex gap-2">
                              <button 
                                onClick={() => exportarCSV(users, colunasUsers, `usuarios_${dataAtual}.csv`)}
                                className="flex-1 px-4 py-2 bg-green-600 text-white rounded-lg font-semibold hover:bg-green-700 text-sm"
                              >
                                📊 CSV
                              </button>
                              <button 
                                onClick={() => exportarJSON(users, `usuarios_${dataAtual}.json`)}
                                className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700 text-sm"
                              >
                                📄 JSON
                              </button>
                            </div>
                          </div>

                          {/* Gratuidades */}
                          <div className="bg-white rounded-xl shadow p-5">
                            <h3 className="font-bold text-gray-800 flex items-center gap-2 mb-3">🎁 Gratuidades</h3>
                            <p className="text-sm text-gray-600 mb-3">{gratuities.length} registros</p>
                            <div className="flex gap-2">
                              <button 
                                onClick={() => exportarCSV(gratuities, colunasGratuities, `gratuidades_${dataAtual}.csv`)}
                                className="flex-1 px-4 py-2 bg-green-600 text-white rounded-lg font-semibold hover:bg-green-700 text-sm"
                              >
                                📊 CSV
                              </button>
                              <button 
                                onClick={() => exportarJSON(gratuities, `gratuidades_${dataAtual}.json`)}
                                className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700 text-sm"
                              >
                                📄 JSON
                              </button>
                            </div>
                          </div>

                          {/* Restritos */}
                          <div className="bg-white rounded-xl shadow p-5">
                            <h3 className="font-bold text-gray-800 flex items-center gap-2 mb-3">🚫 Lista de Restritos</h3>
                            <p className="text-sm text-gray-600 mb-3">{restrictedList.length} registros</p>
                            <div className="flex gap-2">
                              <button 
                                onClick={() => exportarCSV(restrictedList, colunasRestricted, `restritos_${dataAtual}.csv`)}
                                className="flex-1 px-4 py-2 bg-green-600 text-white rounded-lg font-semibold hover:bg-green-700 text-sm"
                              >
                                📊 CSV
                              </button>
                              <button 
                                onClick={() => exportarJSON(restrictedList, `restritos_${dataAtual}.json`)}
                                className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700 text-sm"
                              >
                                📄 JSON
                              </button>
                            </div>
                          </div>

                          {/* Indicações */}
                          <div className="bg-white rounded-xl shadow p-5">
                            <h3 className="font-bold text-gray-800 flex items-center gap-2 mb-3">🤝 Indicações</h3>
                            <p className="text-sm text-gray-600 mb-3">{indicacoes.length} registros</p>
                            <div className="flex gap-2">
                              <button 
                                onClick={() => exportarCSV(indicacoes, colunasIndicacoes, `indicacoes_${dataAtual}.csv`)}
                                className="flex-1 px-4 py-2 bg-green-600 text-white rounded-lg font-semibold hover:bg-green-700 text-sm"
                              >
                                📊 CSV
                              </button>
                              <button 
                                onClick={() => exportarJSON(indicacoes, `indicacoes_${dataAtual}.json`)}
                                className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700 text-sm"
                              >
                                📄 JSON
                              </button>
                            </div>
                          </div>

                          {/* Solicitações Filtradas */}
                          <div className="bg-white rounded-xl shadow p-5">
                            <h3 className="font-bold text-gray-800 flex items-center gap-2 mb-3">🔍 Solicitações por Status</h3>
                            <div className="space-y-2">
                              <button 
                                onClick={() => exportarCSV(allWithdrawals.filter(w => w.status === 'aprovado' || w.status === 'aprovado_gratuidade'), colunasWithdrawals, `aprovados_${dataAtual}.csv`)}
                                className="w-full px-4 py-2 bg-green-100 text-green-700 rounded-lg font-semibold hover:bg-green-200 text-sm text-left"
                              >
                                ✅ Aprovados ({allWithdrawals.filter(w => w.status === 'aprovado' || w.status === 'aprovado_gratuidade').length})
                              </button>
                              <button 
                                onClick={() => exportarCSV(allWithdrawals.filter(w => w.status === 'aguardando_aprovacao'), colunasWithdrawals, `pendentes_${dataAtual}.csv`)}
                                className="w-full px-4 py-2 bg-yellow-100 text-yellow-700 rounded-lg font-semibold hover:bg-yellow-200 text-sm text-left"
                              >
                                ⏳ Pendentes ({allWithdrawals.filter(w => w.status === 'aguardando_aprovacao').length})
                              </button>
                              <button 
                                onClick={() => exportarCSV(allWithdrawals.filter(w => w.status === 'rejeitado'), colunasWithdrawals, `rejeitados_${dataAtual}.csv`)}
                                className="w-full px-4 py-2 bg-red-100 text-red-700 rounded-lg font-semibold hover:bg-red-200 text-sm text-left"
                              >
                                ❌ Rejeitados ({allWithdrawals.filter(w => w.status === 'rejeitado').length})
                              </button>
                            </div>
                          </div>
                        </div>

                        {/* Dicas */}
                        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
                          <h4 className="font-semibold text-amber-800 flex items-center gap-2">💡 Dicas de Backup</h4>
                          <ul className="text-sm text-amber-700 mt-2 space-y-1">
                            <li>• Faça backups regularmente (recomendado: semanalmente)</li>
                            <li>• O arquivo JSON pode ser usado para restaurar dados</li>
                            <li>• O arquivo CSV pode ser aberto no Excel ou Google Sheets</li>
                            <li>• Guarde os backups em local seguro (Google Drive, OneDrive, etc.)</li>
                          </ul>
                        </div>
                      </div>
                    );
                  })()}
                </>
              )}
            </div>
          </div>
        );
      }

      // ========== MÓDULO DISPONIBILIDADE ==========
      // Quando "Disponibilidade" é selecionado, mostrar interface dedicada
      // A lógica completa já está na aba 'disponibilidade' dentro do painel admin
      // Aqui apenas garantimos que quando o módulo é 'disponibilidade', mostramos o painel admin com essa aba

      // ========== PAINEL ADMIN NORMAL (e Admin Master no módulo Solicitações/Disponibilidade) ==========
      const isAdminMasterSolicitacoes = user.role === 'admin_master' && (adminMasterModule === 'solicitacoes' || adminMasterModule === 'disponibilidade');
      const isAdminNormal = user.role === 'admin';
      
      return (
        <div className="min-h-screen bg-gray-50">
          {toast && <Toast {...toast} />}
          {globalLoading && <LoadingOverlay />}
          {imageModal && <ImageModal imageUrl={imageModal} onClose={() => setImageModal(null)} />}

          {isAdminMasterSolicitacoes ? (
            /* Navbar Admin Master */
            <nav className="bg-gradient-to-r from-indigo-900 to-purple-900 shadow-lg">
              <div className="max-w-7xl mx-auto px-4 py-4 flex justify-between items-center">
                <div className="flex items-center gap-4">
                  <div>
                    <h1 className="text-xl font-bold text-white">👑 Admin Master</h1>
                    <p className="text-xs text-indigo-200">{user.fullName}</p>
                  </div>
                  <div className="flex bg-white/10 rounded-lg p-1">
                    <button onClick={() => { setAdminMasterModule('solicitacoes'); setFormData(f => ({...f, adminTab: 'dashboard'})); }} className={`px-4 py-2 rounded-lg text-sm font-semibold transition-all ${adminMasterModule === 'solicitacoes' && formData.adminTab !== 'disponibilidade' ? 'bg-white text-purple-900' : 'text-white hover:bg-white/10'}`}>
                      📋 Solicitações
                    </button>
                    <button onClick={() => setAdminMasterModule('financeiro')} className={`px-4 py-2 rounded-lg text-sm font-semibold transition-all ${adminMasterModule === 'financeiro' ? 'bg-white text-green-800' : 'text-white hover:bg-white/10'}`}>
                      💰 Financeiro
                    </button>
                    <button onClick={() => { setAdminMasterModule('solicitacoes'); setFormData(f => ({...f, adminTab: 'disponibilidade'})); }} className={`px-4 py-2 rounded-lg text-sm font-semibold transition-all ${adminMasterModule === 'solicitacoes' && formData.adminTab === 'disponibilidade' ? 'bg-white text-blue-800' : 'text-white hover:bg-white/10'}`}>
                      📅 Disponibilidade
                    </button>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-2 bg-white/10 px-3 py-1 rounded-full">
                    <span className={`w-2 h-2 rounded-full ${isPolling ? 'bg-yellow-400 animate-pulse' : 'bg-green-400'}`}></span>
                    <span className="text-xs text-indigo-200">{isPolling ? 'Atualizando...' : lastUpdate ? `${lastUpdate.toLocaleTimeString('pt-BR', {hour: '2-digit', minute: '2-digit'})}` : '60s'}</span>
                  </div>
                  <button onClick={refreshAll} className="px-4 py-2 bg-white/20 text-white rounded-lg hover:bg-white/30 text-sm font-semibold">🔄</button>
                  <button onClick={() => setUser(null)} className="px-4 py-2 text-white hover:bg-white/20 rounded-lg">Sair</button>
                </div>
              </div>
            </nav>
          ) : isAdminNormal ? (
            /* Navbar Admin Normal com alternância de módulos */
            <nav className="bg-purple-900 shadow-lg">
              <div className="max-w-7xl mx-auto px-4 py-4 flex justify-between items-center">
                <div className="flex items-center gap-3">
                  <h1 className="text-xl font-bold text-white">Painel Admin</h1>
                  <div className="flex bg-purple-800/50 rounded-lg p-1">
                    <button onClick={() => { setAdminMasterModule('solicitacoes'); setFormData(f => ({...f, adminTab: 'dashboard'})); }} className={`px-3 py-1.5 rounded-lg text-sm font-semibold transition-all ${formData.adminTab !== 'disponibilidade' ? 'bg-white text-purple-900' : 'text-white hover:bg-white/10'}`}>
                      📋 Solicitações
                    </button>
                    <button onClick={() => { setAdminMasterModule('solicitacoes'); setFormData(f => ({...f, adminTab: 'disponibilidade'})); }} className={`px-3 py-1.5 rounded-lg text-sm font-semibold transition-all ${formData.adminTab === 'disponibilidade' ? 'bg-white text-blue-800' : 'text-white hover:bg-white/10'}`}>
                      📅 Disponibilidade
                    </button>
                  </div>
                  <div className="flex items-center gap-2 bg-purple-800/50 px-3 py-1 rounded-full">
                    <span className={`w-2 h-2 rounded-full ${isPolling ? 'bg-yellow-400 animate-pulse' : 'bg-green-400'}`}></span>
                    <span className="text-xs text-purple-200">{isPolling ? 'Atualizando...' : lastUpdate ? `${lastUpdate.toLocaleTimeString('pt-BR', {hour: '2-digit', minute: '2-digit'})}` : '60s'}</span>
                  </div>
                </div>
                <div className="flex gap-2">
                  <button onClick={refreshAll} className="px-4 py-2 bg-purple-700 text-white rounded-lg hover:bg-purple-600 text-sm font-semibold">🔄 Atualizar</button>
                  <button onClick={() => setUser(null)} className="px-4 py-2 text-white hover:bg-purple-800 rounded-lg">Sair</button>
                </div>
              </div>
            </nav>
          ) : null}

          {/* Abas internas - só mostra quando NÃO está em disponibilidade */}
          {formData.adminTab !== 'disponibilidade' && (
            <div className="bg-white border-b sticky top-0 z-10">
              <div className="max-w-7xl mx-auto px-4 flex gap-1 overflow-x-auto">
                {['dashboard', 'search', 'ranking', 'relatorios', 'users'].map(tab => (
                  <button key={tab} onClick={() => setFormData({...formData, adminTab: tab})} className={`px-4 py-2.5 text-sm font-semibold whitespace-nowrap ${(!formData.adminTab && tab === 'dashboard') || formData.adminTab === tab ? 'text-purple-900 border-b-2 border-purple-900' : 'text-gray-600'}`}>
                    {tab === 'dashboard' && '📊 Dashboard'}
                    {tab === 'search' && '🔍 Busca Detalhada'}
                    {tab === 'ranking' && '🏆 Ranking'}
                    {tab === 'relatorios' && '📈 Relatórios'}
                    {tab === 'users' && '👥 Usuários'}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="max-w-7xl mx-auto p-6">
            {/* DASHBOARD */}
            {(!formData.adminTab || formData.adminTab === 'dashboard') && (
              <>
                <div className="grid md:grid-cols-4 gap-4 mb-6">
                  <div className="bg-white p-6 rounded-xl shadow"><p className="text-sm text-gray-600">Total</p><p className="text-3xl font-bold text-purple-900">{submissions.length}</p></div>
                  <div className="bg-white p-6 rounded-xl shadow"><p className="text-sm text-gray-600">Pendentes</p><p className="text-3xl font-bold text-yellow-600">{submissions.filter(s => s.status === 'pendente').length}</p></div>
                  <div className="bg-white p-6 rounded-xl shadow"><p className="text-sm text-gray-600">Aprovadas</p><p className="text-3xl font-bold text-green-600">{submissions.filter(s => s.status === 'aprovada').length}</p></div>
                  <div className="bg-white p-6 rounded-xl shadow"><p className="text-sm text-gray-600">Rejeitadas</p><p className="text-3xl font-bold text-red-600">{submissions.filter(s => s.status === 'rejeitada').length}</p></div>
                </div>

                {/* GRÁFICOS */}
                <div className="grid md:grid-cols-2 gap-6 mb-6">
                  <MotivosPieChart submissions={submissions} />
                  <PieChart 
                    data={[
                      { label: '✓ Aprovadas', value: submissions.filter(s => s.status === 'aprovada').length, color: '#22c55e' },
                      { label: '✗ Rejeitadas', value: submissions.filter(s => s.status === 'rejeitada').length, color: '#ef4444' },
                      { label: '⏳ Pendentes', value: submissions.filter(s => s.status === 'pendente').length, color: '#fbbf24' }
                    ]}
                    title="📈 Status das Solicitações"
                  />
                </div>

                {/* VALIDAÇÃO PENDENTES */}
                <div className="bg-white rounded-xl shadow p-6">
                  <h2 className="text-lg font-semibold mb-4">Aguardando Validação</h2>
                  <div className="mb-4 flex flex-wrap gap-2">
                    {['all', 'retorno', 'ponto1', 'pedagio'].map(f => (
                      <button key={f} onClick={() => setFormData({...formData, pendingFilter: f})} className={`px-4 py-2 rounded-lg font-semibold ${(formData.pendingFilter || 'all') === f ? 'bg-purple-600 text-white' : 'bg-gray-100'}`}>
                        {f === 'all' && `📋 Todos (${submissions.filter(s => s.status === 'pendente').length})`}
                        {f === 'retorno' && `🔄 Retorno (${submissions.filter(s => s.status === 'pendente' && s.motivo === 'Ajuste de Retorno').length})`}
                        {f === 'ponto1' && `📍 Ponto 1 (${submissions.filter(s => s.status === 'pendente' && s.motivo?.includes('Ponto 1')).length})`}
                        {f === 'pedagio' && `🛣️ Pedágio (${submissions.filter(s => s.status === 'pendente' && s.motivo?.includes('Pedágio')).length})`}
                      </button>
                    ))}
                  </div>
                  <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-3">
                    {submissions.filter(s => {
                      if (s.status !== 'pendente') return false;
                      if (!formData.pendingFilter || formData.pendingFilter === 'all') return true;
                      if (formData.pendingFilter === 'retorno') return s.motivo === 'Ajuste de Retorno';
                      if (formData.pendingFilter === 'ponto1') return s.motivo?.includes('Ponto 1');
                      if (formData.pendingFilter === 'pedagio') return s.motivo?.includes('Pedágio');
                      return true;
                    }).map(s => (
                      <div key={s.id} className="border rounded-lg p-3 text-sm">
                        <p className="font-mono text-lg font-bold">OS: {s.ordemServico}</p>
                        <p className="text-xs text-gray-700">{s.fullName}</p>
                        <p className="text-xs text-purple-900 font-semibold">{s.motivo}</p>
                        {s.coordenadas && (
                          <div className="mt-2 bg-green-50 border border-green-200 rounded p-2">
                            <p className="text-xs font-mono text-green-900">{s.coordenadas}</p>
                            <div className="flex gap-2 mt-1">
                              <button onClick={() => { navigator.clipboard.writeText(s.coordenadas); showToast('Copiado!', 'success'); }} className="text-xs text-green-600">📋 Copiar</button>
                              <a href={`https://www.google.com/maps?q=${s.coordenadas}`} target="_blank" className="text-xs text-green-600">🗺️ Maps</a>
                            </div>
                          </div>
                        )}
                        {s.temImagem && (
                          <div className="mt-2">
                            {s.imagemComprovante ? (
                              <>
                                <div className="flex gap-2 flex-wrap">
                                  {s.imagemComprovante.split('|||').map((img, i) => <img key={i} src={img} className="h-20 rounded cursor-pointer" onClick={() => setImageModal(img)} />)}
                                </div>
                                <button onClick={() => setSubmissions(prev => prev.map(sub => sub.id === s.id ? {...sub, imagemComprovante: null} : sub))} className="text-xs text-gray-500">▲ Ocultar</button>
                              </>
                            ) : (
                              <button onClick={() => { showToast('🔄 Carregando...', 'success'); loadImagem(s.id); }} className="px-2 py-1 bg-blue-100 text-blue-800 rounded text-xs font-semibold">📷 Ver foto(s)</button>
                            )}
                          </div>
                        )}
                        <textarea placeholder="Obs (opcional)" value={formData[`obs_${s.id}`] || ''} onChange={e => setFormData({...formData, [`obs_${s.id}`]: e.target.value})} className="w-full px-2 py-1 border rounded mt-2 text-xs" rows="1" />
                        <div className="flex gap-2 mt-2">
                          <button onClick={() => handleValidate(s.id, true)} className="flex-1 bg-green-600 text-white py-1 rounded text-xs font-semibold">✓ Aprovar</button>
                          <button onClick={() => handleValidate(s.id, false)} className="flex-1 bg-red-600 text-white py-1 rounded text-xs font-semibold">✗ Rejeitar</button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}

            {/* BUSCA DETALHADA */}
            {formData.adminTab === 'search' && (
              <div className="bg-white rounded-xl shadow p-6">
                <div className="flex flex-wrap gap-4 mb-6">
                  <input type="text" placeholder="🔍 Buscar por OS ou código..." value={formData.searchOS || ''} onChange={e => setFormData({...formData, searchOS: e.target.value})} className="flex-1 px-4 py-2 border rounded-lg" />
                  <select value={formData.statusFilter || ''} onChange={e => setFormData({...formData, statusFilter: e.target.value})} className="px-4 py-2 border rounded-lg">
                    <option value="">Todos status</option>
                    <option value="pendente">Pendente</option>
                    <option value="aprovada">Aprovada</option>
                    <option value="rejeitada">Rejeitada</option>
                  </select>
                  <select value={formData.dateFilter || ''} onChange={e => setFormData({...formData, dateFilter: e.target.value})} className="px-4 py-2 border rounded-lg">
                    <option value="">Todo período</option>
                    <option value="today">Hoje</option>
                    <option value="week">Esta semana</option>
                    <option value="month">Este mês</option>
                  </select>
                </div>
                <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-3">
                  {submissions.filter(s => {
                    if (formData.searchOS && !s.ordemServico?.toLowerCase().includes(formData.searchOS.toLowerCase()) && !s.codProfissional?.toLowerCase().includes(formData.searchOS.toLowerCase())) return false;
                    if (formData.statusFilter && s.status !== formData.statusFilter) return false;
                    if (formData.dateFilter) {
                      const today = new Date(); today.setHours(0,0,0,0);
                      const subDate = new Date(s.created_at);
                      if (formData.dateFilter === 'today') { const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate()+1); if (subDate < today || subDate >= tomorrow) return false; }
                      else if (formData.dateFilter === 'week') { const weekAgo = new Date(today); weekAgo.setDate(weekAgo.getDate()-7); if (subDate < weekAgo) return false; }
                      else if (formData.dateFilter === 'month') { const monthAgo = new Date(today); monthAgo.setMonth(monthAgo.getMonth()-1); if (subDate < monthAgo) return false; }
                    }
                    return true;
                  }).map(s => (
                    <div key={s.id} className={`border rounded-lg p-3 text-sm ${s.status === 'aprovada' ? 'bg-green-50' : s.status === 'rejeitada' ? 'bg-red-50' : 'bg-yellow-50'}`}>
                      <div className="flex justify-between items-start mb-1">
                        <div><p className="font-mono font-bold">OS: {s.ordemServico}</p><p className="text-xs text-gray-700">{s.fullName}</p></div>
                        <div className="flex items-center gap-1">
                          <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${s.status === 'aprovada' ? 'bg-green-600 text-white' : s.status === 'rejeitada' ? 'bg-red-600 text-white' : 'bg-yellow-600 text-white'}`}>{s.status?.toUpperCase()}</span>
                          <button onClick={async () => { if (!confirm(`Excluir OS ${s.ordemServico}?`)) return; await fetch(`${API_URL}/submissions/${s.id}`, { method: 'DELETE' }); showToast('🗑️ Excluída!', 'success'); loadSubmissions(); }} className="px-1.5 py-0.5 bg-red-600 text-white rounded text-xs">🗑️</button>
                        </div>
                      </div>
                      <p className="text-xs text-gray-600">{s.motivo}</p>
                      {s.coordenadas && (
                        <div className="mt-1 bg-green-50 border border-green-200 rounded p-1.5 flex items-center justify-between">
                          <p className="text-xs font-mono text-green-900">{s.coordenadas}</p>
                          <button onClick={() => { navigator.clipboard.writeText(s.coordenadas); showToast('📋 Copiado!', 'success'); }} className="px-1.5 py-0.5 bg-green-600 text-white text-xs rounded">📋</button>
                        </div>
                      )}
                      {s.temImagem && (
                        <div className="mt-1">
                          {s.imagemComprovante ? (
                            <>
                              <div className="flex gap-1 flex-wrap">{s.imagemComprovante.split('|||').map((img, i) => <img key={i} src={img} className="h-20 rounded cursor-pointer" onClick={() => setImageModal(img)} />)}</div>
                              <button onClick={() => setSubmissions(prev => prev.map(sub => sub.id === s.id ? {...sub, imagemComprovante: null} : sub))} className="text-xs text-gray-500">▲ Ocultar</button>
                            </>
                          ) : (
                            <button onClick={() => { showToast('🔄 Carregando...', 'success'); loadImagem(s.id); }} className="px-2 py-0.5 bg-blue-100 text-blue-800 rounded text-xs font-semibold">📷 Ver foto(s)</button>
                          )}
                        </div>
                      )}
                      {s.observacao && <div className="mt-1 bg-white p-1 rounded border"><p className="text-xs text-gray-600">Obs: {s.observacao}</p></div>}
                      <div className="flex justify-between items-center mt-1">
                        <p className="text-xs text-gray-400">{s.timestamp}</p>
                        {s.validated_by_name && s.status !== 'pendente' && <p className="text-xs text-purple-600 font-semibold">👤 {s.validated_by_name}</p>}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* RANKING */}
            {formData.adminTab === 'ranking' && (
              <div className="bg-white rounded-xl shadow p-6">
                <h2 className="text-lg font-semibold mb-4">🏆 Ranking de Retorno - Aprovações</h2>
                <div className="mb-6">
                  <select value={formData.rankingPeriod || 'all'} onChange={e => setFormData({...formData, rankingPeriod: e.target.value})} className="px-4 py-2 border rounded-lg">
                    <option value="all">📅 Todos os Tempos</option>
                    <option value="today">📅 Hoje</option>
                    <option value="week">📅 Esta Semana</option>
                    <option value="month">📅 Este Mês</option>
                  </select>
                </div>
                <div className="space-y-3">
                  {(() => {
                    const today = new Date(); today.setHours(0,0,0,0);
                    const filtered = submissions.filter(s => {
                      if (s.status !== 'aprovada' || s.motivo !== 'Ajuste de Retorno') return false;
                      if (!formData.rankingPeriod || formData.rankingPeriod === 'all') return true;
                      const subDate = new Date(s.created_at);
                      if (formData.rankingPeriod === 'today') { const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate()+1); return subDate >= today && subDate < tomorrow; }
                      if (formData.rankingPeriod === 'week') { const weekAgo = new Date(today); weekAgo.setDate(weekAgo.getDate()-7); return subDate >= weekAgo; }
                      if (formData.rankingPeriod === 'month') { const monthAgo = new Date(today); monthAgo.setMonth(monthAgo.getMonth()-1); return subDate >= monthAgo; }
                      return true;
                    });
                    const stats = {};
                    filtered.forEach(s => { const n = s.fullName || 'Desconhecido'; stats[n] = (stats[n] || 0) + 1; });
                    const ranking = Object.entries(stats).sort((a, b) => b[1] - a[1]);
                    if (ranking.length === 0) return <p className="text-gray-500 text-center py-8">Sem dados no período</p>;
                    return ranking.map(([name, count], i) => (
                      <div key={i} className="flex items-center gap-4 p-4 bg-gray-50 rounded-lg hover:bg-gray-100">
                        <div className={`text-3xl font-bold w-12 ${i === 0 ? 'text-yellow-500' : i === 1 ? 'text-gray-400' : i === 2 ? 'text-orange-600' : 'text-gray-400'}`}>{i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i+1}º`}</div>
                        <div className="flex-1"><p className="font-semibold text-lg text-gray-800">{name}</p></div>
                        <div className="text-right"><p className="text-3xl font-bold text-purple-600">{count}</p><p className="text-xs text-gray-500">aprovações</p></div>
                      </div>
                    ));
                  })()}
                </div>
              </div>
            )}

            {/* ========== DISPONIBILIDADE ========== */}
            {formData.adminTab === 'disponibilidade' && (
              <>
                {(() => {
                  // Estado local para disponibilidade
                  const dispData = formData.dispData || { regioes: [], lojas: [], linhas: [] };
                  const dispSubTab = formData.dispSubTab || 'panorama';
                  const dispLoading = formData.dispLoading;
                  
                  // Carregar dados da API
                  const loadDisponibilidade = async () => {
                    try {
                      setFormData(f => ({...f, dispLoading: true}));
                      const res = await fetch(`${API_URL}/disponibilidade`);
                      if (!res.ok) throw new Error('Erro ao carregar');
                      const data = await res.json();
                      setFormData(f => ({...f, dispData: data, dispLoading: false, dispLoaded: true}));
                    } catch (err) {
                      console.error('Erro ao carregar disponibilidade:', err);
                      showToast('Erro ao carregar dados', 'error');
                      setFormData(f => ({...f, dispLoading: false, dispLoaded: true}));
                    }
                  };
                  
                  // Carregar ao abrir a aba
                  if (!formData.dispLoaded && !dispLoading) {
                    loadDisponibilidade();
                    // Carregar planilha do Google Sheets se ainda não foi carregada
                    if (profissionaisSheet.length === 0) {
                      loadProfissionaisSheet();
                    }
                  }
                  
                  // Adicionar região
                  const addRegiao = async () => {
                    const nome = formData.novaRegiao?.trim();
                    if (!nome) { showToast('Digite o nome da região', 'error'); return; }
                    
                    try {
                      const res = await fetch(`${API_URL}/disponibilidade/regioes`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ nome })
                      });
                      if (!res.ok) {
                        const err = await res.json();
                        throw new Error(err.error || 'Erro ao criar');
                      }
                      setFormData(f => ({...f, novaRegiao: ''}));
                      showToast(`✅ Região "${nome}" adicionada!`, 'success');
                      loadDisponibilidade();
                    } catch (err) {
                      showToast(err.message, 'error');
                    }
                  };
                  
                  // Remover região
                  const removeRegiao = async (id, nome) => {
                    if (!window.confirm(`Remover região "${nome}" e todas suas lojas?`)) return;
                    try {
                      await fetch(`${API_URL}/disponibilidade/regioes/${id}`, { method: 'DELETE' });
                      showToast(`🗑️ Região "${nome}" removida!`, 'success');
                      loadDisponibilidade();
                    } catch (err) {
                      showToast('Erro ao remover região', 'error');
                    }
                  };
                  
                  // Adicionar loja
                  const addLoja = async () => {
                    const codigo = formData.novaCodLoja?.trim();
                    const nome = formData.novaNomeLoja?.trim();
                    const regiao_id = formData.novaLojaRegiaoId;
                    const qtd_titulares = parseInt(formData.novaQtdTitulares) || 0;
                    const qtd_excedentes = parseInt(formData.novaQtdExcedentes) || 0;
                    
                    if (!codigo || !nome || !regiao_id) { showToast('Preencha todos os campos', 'error'); return; }
                    if (qtd_titulares === 0 && qtd_excedentes === 0) { showToast('Adicione pelo menos 1 linha', 'error'); return; }
                    
                    try {
                      const res = await fetch(`${API_URL}/disponibilidade/lojas`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ regiao_id, codigo, nome, qtd_titulares, qtd_excedentes })
                      });
                      if (!res.ok) throw new Error('Erro ao criar loja');
                      setFormData(f => ({...f, novaCodLoja: '', novaNomeLoja: '', novaQtdTitulares: '', novaQtdExcedentes: '', novaLojaRegiaoId: ''}));
                      showToast(`✅ Loja "${nome}" adicionada com ${qtd_titulares} titular(es) e ${qtd_excedentes} excedente(s)!`, 'success');
                      loadDisponibilidade();
                    } catch (err) {
                      showToast('Erro ao criar loja', 'error');
                    }
                  };
                  
                  // Remover loja
                  const removeLoja = async (id, nome) => {
                    if (!window.confirm(`Remover loja "${nome}"?`)) return;
                    try {
                      await fetch(`${API_URL}/disponibilidade/lojas/${id}`, { method: 'DELETE' });
                      showToast(`🗑️ Loja removida!`, 'success');
                      loadDisponibilidade();
                    } catch (err) {
                      showToast('Erro ao remover loja', 'error');
                    }
                  };
                  
                  // Atualizar linha
                  const updateLinha = async (linhaId, campo, valor) => {
                    // Atualizar local primeiro para UI responsiva
                    const novasLinhas = [...(dispData.linhas || [])];
                    const idx = novasLinhas.findIndex(l => l.id === linhaId);
                    if (idx === -1) return;
                    
                    const linhaAtual = novasLinhas[idx];
                    
                    // Se está alterando o código, verificar restrição
                    if (campo === 'cod_profissional' && valor && valor.trim() !== '') {
                      try {
                        const resVerif = await fetch(`${API_URL}/disponibilidade/restricoes/verificar?cod_profissional=${valor}&loja_id=${linhaAtual.loja_id}`);
                        const restricao = await resVerif.json();
                        
                        if (restricao.restrito) {
                          // Mostrar popup de restrição
                          const lojaInfo = restricao.todas_lojas 
                            ? 'TODAS AS LOJAS' 
                            : `loja ${restricao.loja_codigo} - ${restricao.loja_nome}`;
                          
                          alert(`🚫 MOTOBOY RESTRITO!\n\nCódigo: ${valor}\nRestrito em: ${lojaInfo}\n\nMotivo: ${restricao.motivo}\n\nEste motoboy não pode ser inserido nesta loja.`);
                          
                          // Não permitir a alteração - limpar o campo
                          return;
                        }
                      } catch (err) {
                        console.error('Erro ao verificar restrição:', err);
                      }
                    }
                    
                    novasLinhas[idx] = { ...novasLinhas[idx], [campo]: valor };
                    
                    // Se digitou código, buscar nome automaticamente na planilha do Google Sheets
                    // Se apagou o código, limpar o nome também
                    let nomeProfissional = novasLinhas[idx].nome_profissional;
                    if (campo === 'cod_profissional') {
                      if (!valor || valor.trim() === '') {
                        // Código foi apagado, limpar nome
                        nomeProfissional = '';
                        novasLinhas[idx].nome_profissional = '';
                      } else if (valor.length >= 1) {
                        // Primeiro tenta na planilha do Google Sheets
                        const profSheet = profissionaisSheet.find(p => p.codigo === valor.toString());
                        if (profSheet) {
                          nomeProfissional = profSheet.nome;
                          novasLinhas[idx].nome_profissional = profSheet.nome;
                        } else {
                          // Se não encontrar na planilha, tenta na base de usuários
                          const user = users.find(u => u.codProfissional?.toLowerCase() === valor.toLowerCase());
                          if (user) {
                            nomeProfissional = user.fullName;
                            novasLinhas[idx].nome_profissional = user.fullName;
                          } else {
                            nomeProfissional = '';
                            novasLinhas[idx].nome_profissional = '';
                          }
                        }
                      }
                    }
                    
                    setFormData(f => ({...f, dispData: {...dispData, linhas: novasLinhas}}));
                    
                    // Salvar no banco (debounce)
                    clearTimeout(window.dispDebounce);
                    window.dispDebounce = setTimeout(async () => {
                      try {
                        await fetch(`${API_URL}/disponibilidade/linhas/${linhaId}`, {
                          method: 'PUT',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({
                            cod_profissional: novasLinhas[idx].cod_profissional || null,
                            nome_profissional: campo === 'cod_profissional' ? (nomeProfissional || null) : (novasLinhas[idx].nome_profissional || null),
                            status: novasLinhas[idx].status,
                            observacao: novasLinhas[idx].observacao
                          })
                        });
                      } catch (err) {
                        console.error('Erro ao salvar linha:', err);
                      }
                    }, 500);
                  };
                  
                  // Adicionar mais linhas a uma loja
                  const addLinhasLoja = async (lojaId, qtd, isExcedente = false) => {
                    try {
                      await fetch(`${API_URL}/disponibilidade/linhas`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ loja_id: lojaId, quantidade: qtd, is_excedente: isExcedente })
                      });
                      showToast(`✅ ${qtd} ${isExcedente ? 'excedente(s)' : 'titular(es)'} adicionado(s)!`, 'success');
                      loadDisponibilidade();
                    } catch (err) {
                      showToast('Erro ao adicionar linhas', 'error');
                    }
                  };
                  
                  // Marcar como faltando (abre modal de motivo)
                  const marcarFaltando = (linha) => {
                    setFormData(f => ({
                      ...f, 
                      modalFaltando: true,
                      faltandoLinha: linha,
                      faltandoMotivo: ''
                    }));
                  };
                  
                  // Confirmar falta com motivo
                  const confirmarFalta = async () => {
                    const linha = formData.faltandoLinha;
                    const motivo = formData.faltandoMotivo?.trim();
                    
                    if (!motivo) {
                      showToast('Digite o motivo da falta', 'error');
                      return;
                    }
                    
                    const dataPlanilha = formData.dispDataPlanilha || new Date().toISOString().split('T')[0];
                    
                    try {
                      // 1. Atualizar status para FALTANDO
                      await fetch(`${API_URL}/disponibilidade/linhas/${linha.id}`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                          cod_profissional: linha.cod_profissional,
                          nome_profissional: linha.nome_profissional,
                          status: 'FALTANDO',
                          observacao: motivo
                        })
                      });
                      
                      // 2. Registrar na tabela de faltosos (com data da planilha)
                      await fetch(`${API_URL}/disponibilidade/faltosos`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                          loja_id: linha.loja_id,
                          cod_profissional: linha.cod_profissional,
                          nome_profissional: linha.nome_profissional,
                          motivo,
                          data_falta: dataPlanilha
                        })
                      });
                      
                      // 3. Criar linha de reposição
                      const reposicaoRes = await fetch(`${API_URL}/disponibilidade/linha-reposicao`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                          loja_id: linha.loja_id,
                          after_linha_id: linha.id
                        })
                      });
                      const novaReposicao = await reposicaoRes.json();
                      
                      // 4. Atualizar estado local (sem reload!)
                      const novasLinhas = [...(dispData.linhas || [])];
                      const idx = novasLinhas.findIndex(l => l.id === linha.id);
                      if (idx !== -1) {
                        novasLinhas[idx] = {
                          ...novasLinhas[idx],
                          status: 'FALTANDO',
                          observacao: motivo
                        };
                      }
                      // Adicionar nova linha de reposição
                      novasLinhas.push(novaReposicao);
                      
                      setFormData(f => ({
                        ...f, 
                        modalFaltando: false, 
                        faltandoLinha: null, 
                        faltandoMotivo: '',
                        dispData: { ...dispData, linhas: novasLinhas }
                      }));
                      
                      showToast('⚠️ Falta registrada e linha de reposição criada!', 'success');
                    } catch (err) {
                      console.error('Erro ao registrar falta:', err);
                      showToast('Erro ao registrar falta', 'error');
                    }
                  };
                  
                  // Resetar status (salva espelho e limpa tudo)
                  const resetarStatus = async () => {
                    const dataPlanilha = formData.dispDataPlanilha || new Date().toISOString().split('T')[0];
                    const dataFormatada = new Date(dataPlanilha + 'T12:00:00').toLocaleDateString('pt-BR');
                    
                    if (!window.confirm(`⚠️ ATENÇÃO!\n\n📅 Data da planilha: ${dataFormatada}\n\nIsso irá:\n• Salvar a planilha atual no Espelho (${dataFormatada})\n• Registrar motoboys EM LOJA e SEM CONTATO\n• Remover motoboys com 3+ dias SEM CONTATO\n• Resetar todos os status para "A CONFIRMAR"\n• Limpar todas as observações\n• Converter linhas de reposição em excedentes\n\n✅ Os códigos e nomes serão MANTIDOS!\n\nDeseja continuar?`)) {
                      return;
                    }
                    
                    try {
                      setFormData(f => ({...f, dispLoading: true}));
                      const res = await fetch(`${API_URL}/disponibilidade/resetar`, { 
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ data_planilha: dataPlanilha })
                      });
                      const data = await res.json();
                      if (data.success) {
                        let msg = `✅ Status resetado! Espelho salvo em ${dataFormatada}`;
                        if (data.em_loja_registrados > 0) {
                          msg += `\n🏪 ${data.em_loja_registrados} motoboy(s) EM LOJA registrado(s)`;
                        }
                        if (data.sem_contato_registrados > 0) {
                          msg += `\n📵 ${data.sem_contato_registrados} motoboy(s) SEM CONTATO registrado(s)`;
                        }
                        if (data.removidos_por_sem_contato && data.removidos_por_sem_contato.length > 0) {
                          msg += `\n\n🚫 REMOVIDOS POR 3 DIAS SEM CONTATO:`;
                          data.removidos_por_sem_contato.forEach(r => {
                            msg += `\n• ${r.cod} - ${r.nome}`;
                          });
                        }
                        showToast(msg, 'success');
                        
                        // Se houve remoções, mostrar alerta adicional
                        if (data.removidos_por_sem_contato && data.removidos_por_sem_contato.length > 0) {
                          setTimeout(() => {
                            alert(`🚫 MOTOBOYS REMOVIDOS POR 3 DIAS SEM CONTATO:\n\n${data.removidos_por_sem_contato.map(r => `${r.cod} - ${r.nome}`).join('\n')}`);
                          }, 500);
                        }
                      } else {
                        showToast('Erro ao resetar', 'error');
                      }
                      loadDisponibilidade();
                    } catch (err) {
                      console.error('Erro ao resetar:', err);
                      showToast('Erro ao resetar', 'error');
                      setFormData(f => ({...f, dispLoading: false}));
                    }
                  };
                  
                  // Remover linha
                  const removeLinha = async (linhaId) => {
                    try {
                      await fetch(`${API_URL}/disponibilidade/linhas/${linhaId}`, { method: 'DELETE' });
                      loadDisponibilidade();
                    } catch (err) {
                      showToast('Erro ao remover linha', 'error');
                    }
                  };
                  
                  // Limpar todas as linhas
                  const limparLinhas = async () => {
                    if (!window.confirm('Limpar TODAS as linhas? (mantém a estrutura de regiões e lojas)')) return;
                    try {
                      await fetch(`${API_URL}/disponibilidade/limpar-linhas`, { method: 'DELETE' });
                      showToast('✅ Todas as linhas foram resetadas!', 'success');
                      loadDisponibilidade();
                    } catch (err) {
                      showToast('Erro ao limpar linhas', 'error');
                    }
                  };
                  
                  // Cores dos status
                  const statusColors = {
                    'A CONFIRMAR': 'bg-yellow-100 text-yellow-800 border-yellow-300',
                    'CONFIRMADO': 'bg-green-100 text-green-800 border-green-300',
                    'A CAMINHO': 'bg-orange-100 text-orange-800 border-orange-300',
                    'EM LOJA': 'bg-blue-100 text-blue-800 border-blue-300',
                    'FALTANDO': 'bg-red-100 text-red-800 border-red-300',
                    'SEM CONTATO': 'bg-gray-100 text-gray-800 border-gray-300'
                  };
                  
                  // Cores das linhas por status
                  const rowColors = {
                    'A CONFIRMAR': 'bg-yellow-50',
                    'CONFIRMADO': 'bg-green-50',
                    'A CAMINHO': 'bg-orange-50',
                    'EM LOJA': 'bg-blue-50',
                    'FALTANDO': 'bg-red-50',
                    'SEM CONTATO': 'bg-gray-50'
                  };
                  
                  if (dispLoading) {
                    return (
                      <div className="flex items-center justify-center py-12">
                        <div className="text-center">
                          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-purple-600 mx-auto"></div>
                          <p className="mt-4 text-gray-600">Carregando...</p>
                        </div>
                      </div>
                    );
                  }
                  
                  return (
                    <div className="space-y-4">
                      {/* Indicador de Sincronização em Tempo Real */}
                      <div className="flex items-center justify-end gap-2 text-xs text-gray-500">
                        <span className="flex items-center gap-1">
                          <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></span>
                          Sincronização automática ativa (10s)
                        </span>
                      </div>
                      
                      {/* Sub-abas */}
                      <div className="bg-white rounded-xl shadow">
                        <div className="flex border-b overflow-x-auto">
                          <button 
                            onClick={() => setFormData({...formData, dispSubTab: 'panorama'})} 
                            className={`px-3 py-2 font-semibold text-sm whitespace-nowrap ${dispSubTab === 'panorama' ? 'text-purple-700 border-b-2 border-purple-600 bg-purple-50' : 'text-gray-600'}`}
                          >
                            📊 Panorama
                          </button>
                          <button 
                            onClick={() => setFormData({...formData, dispSubTab: 'principal'})} 
                            className={`px-3 py-2 font-semibold text-sm whitespace-nowrap ${dispSubTab === 'principal' ? 'text-purple-700 border-b-2 border-purple-600 bg-purple-50' : 'text-gray-600'}`}
                          >
                            📋 Painel
                          </button>
                          <button 
                            onClick={async () => {
                              setFormData(f => ({...f, dispSubTab: 'faltosos'}));
                              // Carregar todas as faltas automaticamente
                              try {
                                const res = await fetch(`${API_URL}/disponibilidade/faltosos`);
                                const data = await res.json();
                                setFormData(f => ({...f, faltososLista: data}));
                              } catch (err) {
                                console.error('Erro ao carregar faltosos:', err);
                              }
                            }} 
                            className={`px-3 py-2 font-semibold text-sm whitespace-nowrap ${dispSubTab === 'faltosos' ? 'text-purple-700 border-b-2 border-purple-600 bg-purple-50' : 'text-gray-600'}`}
                          >
                            ⚠️ Faltosos
                          </button>
                          <button 
                            onClick={async () => {
                              setFormData(f => ({...f, dispSubTab: 'espelho'}));
                              // Carregar datas do espelho
                              try {
                                const res = await fetch(`${API_URL}/disponibilidade/espelho`);
                                const datas = await res.json();
                                setFormData(f => ({...f, espelhoDatas: datas}));
                              } catch (err) {
                                console.error('Erro ao carregar datas espelho:', err);
                              }
                            }} 
                            className={`px-3 py-2 font-semibold text-sm whitespace-nowrap ${dispSubTab === 'espelho' ? 'text-purple-700 border-b-2 border-purple-600 bg-purple-50' : 'text-gray-600'}`}
                          >
                            🪞 Espelho
                          </button>
                          <button 
                            onClick={async () => {
                              setFormData(f => ({...f, dispSubTab: 'relatorios', relatoriosLoading: true}));
                              try {
                                const [metricas, rankingLojas, rankingFaltosos, comparativo, heatmap] = await Promise.all([
                                  fetch(`${API_URL}/disponibilidade/relatorios/metricas`).then(r => r.json()).catch(() => []),
                                  fetch(`${API_URL}/disponibilidade/relatorios/ranking-lojas`).then(r => r.json()).catch(() => []),
                                  fetch(`${API_URL}/disponibilidade/relatorios/ranking-faltosos`).then(r => r.json()).catch(() => []),
                                  fetch(`${API_URL}/disponibilidade/relatorios/comparativo`).then(r => r.json()).catch(() => ({})),
                                  fetch(`${API_URL}/disponibilidade/relatorios/heatmap`).then(r => r.json()).catch(() => ({ diasSemana: [], lojas: [] }))
                                ]);
                                setFormData(f => ({...f, relatoriosData: { 
                                  metricas: Array.isArray(metricas) ? metricas : [], 
                                  rankingLojas: Array.isArray(rankingLojas) ? rankingLojas : [], 
                                  rankingFaltosos: Array.isArray(rankingFaltosos) ? rankingFaltosos : [], 
                                  comparativo: comparativo || {}, 
                                  heatmap: heatmap || { diasSemana: [], lojas: [] }
                                }, relatoriosLoading: false}));
                              } catch (err) {
                                console.error('Erro ao carregar relatórios:', err);
                                setFormData(f => ({...f, relatoriosLoading: false, relatoriosData: { metricas: [], rankingLojas: [], rankingFaltosos: [], comparativo: {}, heatmap: { diasSemana: [], lojas: [] } }}));
                              }
                            }}
                            className={`px-3 py-2 font-semibold text-sm whitespace-nowrap ${dispSubTab === 'relatorios' ? 'text-purple-700 border-b-2 border-purple-600 bg-purple-50' : 'text-gray-600'}`}
                          >
                            📈 Relatórios
                          </button>
                          <button 
                            onClick={async () => {
                              setFormData(f => ({...f, dispSubTab: 'motoboys', motoboysBusca: '', motoboysLojaFiltro: '', motoboysDias: 30, motoboysList: null, motoboysLoading: true}));
                              try {
                                const res = await fetch(`${API_URL}/disponibilidade/motoboys?dias=30`);
                                const data = await res.json();
                                setFormData(f => ({...f, motoboysList: data, motoboysLoading: false}));
                              } catch (err) {
                                console.error('Erro ao carregar motoboys:', err);
                                setFormData(f => ({...f, motoboysLoading: false}));
                              }
                            }}
                            className={`px-3 py-2 font-semibold text-sm whitespace-nowrap ${dispSubTab === 'motoboys' ? 'text-purple-700 border-b-2 border-purple-600 bg-purple-50' : 'text-gray-600'}`}
                          >
                            🏍️ Motoboys
                          </button>
                          <button 
                            onClick={async () => {
                              setFormData(f => ({...f, dispSubTab: 'restricoes', restricoesLoading: true}));
                              try {
                                const res = await fetch(`${API_URL}/disponibilidade/restricoes`);
                                const data = await res.json();
                                setFormData(f => ({...f, restricoesList: data, restricoesLoading: false}));
                              } catch (err) {
                                console.error('Erro ao carregar restrições:', err);
                                setFormData(f => ({...f, restricoesLoading: false}));
                              }
                            }}
                            className={`px-3 py-2 font-semibold text-sm whitespace-nowrap ${dispSubTab === 'restricoes' ? 'text-purple-700 border-b-2 border-purple-600 bg-purple-50' : 'text-gray-600'}`}
                          >
                            🚫 Restrições
                          </button>
                          <button 
                            onClick={() => setFormData({...formData, dispSubTab: 'config'})} 
                            className={`px-3 py-2 font-semibold text-sm whitespace-nowrap ${dispSubTab === 'config' ? 'text-purple-700 border-b-2 border-purple-600 bg-purple-50' : 'text-gray-600'}`}
                          >
                            ⚙️ Config
                          </button>
                        </div>
                      </div>
                      
                      {/* ===== SUB-ABA PANORAMA ===== */}
                      {dispSubTab === 'panorama' && (
                        <div>
                          {/* Header com controles */}
                          <div className="bg-gray-800 text-white px-2 py-1.5 flex justify-between items-center text-[10px] flex-wrap gap-1">
                            <div className="flex items-center gap-2">
                              <span className="font-bold">PANORAMA DIÁRIO</span>
                              {/* Contador em tempo real */}
                              {(() => {
                                const linhas = dispData.linhas || [];
                                const titulares = linhas.filter(l => !l.is_excedente && !l.is_reposicao).length;
                                const emLoja = linhas.filter(l => l.status === 'EM LOJA').length;
                                const emOp = linhas.filter(l => ['A CAMINHO', 'CONFIRMADO', 'EM LOJA'].includes(l.status)).length;
                                const faltam = Math.max(0, titulares - emLoja);
                                // % baseado em EM LOJA vs TITULARES, limitado a 100%
                                const perc = titulares > 0 ? Math.min((emLoja / titulares) * 100, 100).toFixed(0) : 0;
                                return (
                                  <div className="flex items-center gap-2">
                                    <span className={`px-2 py-0.5 rounded text-xs font-bold ${perc >= 80 ? 'bg-green-500' : perc >= 50 ? 'bg-yellow-500 text-black' : 'bg-red-500'}`}>
                                      {perc}% GERAL
                                    </span>
                                    {faltam > 0 && (
                                      <span className="px-2 py-0.5 rounded text-xs font-bold bg-red-600 animate-pulse">
                                        ⚠️ FALTAM {faltam} P/ 100%
                                      </span>
                                    )}
                                  </div>
                                );
                              })()}
                            </div>
                            <div className="flex items-center gap-1 flex-wrap">
                              {/* Horário última atualização */}
                              <span className="text-gray-400 text-[9px]">
                                Atualizado: {new Date().toLocaleTimeString('pt-BR', {hour: '2-digit', minute: '2-digit'})}
                              </span>
                              {/* Ordenação */}
                              <select 
                                value={formData.panoramaOrdem || 'regiao'}
                                onChange={e => setFormData({...formData, panoramaOrdem: e.target.value})}
                                className="px-1 py-0 bg-gray-700 border border-gray-600 rounded text-[9px]"
                              >
                                <option value="regiao">Por Região</option>
                                <option value="pior">Pior → Melhor</option>
                                <option value="melhor">Melhor → Pior</option>
                                <option value="alfa">A → Z</option>
                              </select>
                              <input 
                                type="date" 
                                value={formData.dispDataPlanilha || new Date().toISOString().split('T')[0]} 
                                onChange={e => setFormData({...formData, dispDataPlanilha: e.target.value})}
                                className="px-1 py-0 border border-gray-600 rounded text-[10px] text-white bg-gray-700"
                              />
                              <button onClick={loadDisponibilidade} className="px-1.5 py-0.5 bg-gray-700 text-white rounded hover:bg-gray-600 text-[10px]">
                                🔄
                              </button>
                              {/* Link Público */}
                              <button 
                                onClick={() => {
                                  navigator.clipboard.writeText(`${API_URL}/disponibilidade/publico`);
                                  showToast('✅ Link copiado!', 'success');
                                }}
                                className="px-1.5 py-0.5 bg-blue-600 text-white rounded hover:bg-blue-700 text-[10px]"
                                title="Copiar link público (somente leitura)"
                              >
                                🔗 Link Público
                              </button>
                            </div>
                          </div>
                          
                          {/* Tabela Panorama */}
                          <div className="overflow-x-auto">
                            <table id="panorama-table" style={{fontSize: '9px', borderCollapse: 'collapse', width: '100%'}}>
                              <thead>
                                <tr style={{backgroundColor: '#f8fafc', borderBottom: '2px solid #e2e8f0'}}>
                                  <th style={{padding: '4px 6px', border: '1px solid #e2e8f0', textAlign: 'left', fontWeight: '600', color: '#475569'}}>LOJAS</th>
                                  <th style={{padding: '4px 4px', border: '1px solid #e2e8f0', fontWeight: '600', color: '#475569', whiteSpace: 'nowrap'}}>A CAMINHO</th>
                                  <th style={{padding: '4px 4px', border: '1px solid #e2e8f0', fontWeight: '600', color: '#475569'}}>CONFIR.</th>
                                  <th style={{padding: '4px 4px', border: '1px solid #e2e8f0', fontWeight: '600', color: '#475569', whiteSpace: 'nowrap'}}>EM LOJA</th>
                                  <th style={{padding: '4px 4px', border: '1px solid #e2e8f0', fontWeight: '600', color: '#475569'}}>IDEAL</th>
                                  <th style={{padding: '4px 4px', border: '1px solid #e2e8f0', fontWeight: '600', color: '#475569'}}>FALTA</th>
                                  <th style={{padding: '4px 4px', border: '1px solid #e2e8f0', fontWeight: '600', color: '#475569', whiteSpace: 'nowrap'}}>S/ CONTATO</th>
                                  <th style={{padding: '4px 4px', border: '1px solid #e2e8f0', fontWeight: '600', color: '#475569'}}>%</th>
                                </tr>
                              </thead>
                              <tbody>
                                {(() => {
                                  const ordem = formData.panoramaOrdem || 'regiao';
                                  const regioes = dispData.regioes || [];
                                  const lojas = dispData.lojas || [];
                                  const linhas = dispData.linhas || [];
                                  
                                  // Calcular dados de cada loja
                                  const lojasComDados = lojas.map(loja => {
                                    const linhasLoja = linhas.filter(l => l.loja_id === loja.id);
                                    const titulares = linhasLoja.filter(l => !l.is_excedente && !l.is_reposicao).length;
                                    const aCaminho = linhasLoja.filter(l => l.status === 'A CAMINHO').length;
                                    const confirmado = linhasLoja.filter(l => l.status === 'CONFIRMADO').length;
                                    const emLoja = linhasLoja.filter(l => l.status === 'EM LOJA').length;
                                    const semContato = linhasLoja.filter(l => l.status === 'SEM CONTATO').length;
                                    const emOperacao = aCaminho + confirmado + emLoja;
                                    const falta = Math.max(0, titulares - emOperacao);
                                    // % baseado em EM LOJA vs TITULARES, limitado a 100%
                                    const perc = titulares > 0 ? Math.min((emLoja / titulares) * 100, 100) : 0;
                                    const regiao = regioes.find(r => r.id === loja.regiao_id);
                                    return { ...loja, titulares, aCaminho, confirmado, emLoja, semContato, emOperacao, falta, perc, regiao };
                                  });
                                  
                                  // Totais gerais
                                  let totalGeral = { aCaminho: 0, confirmado: 0, emLoja: 0, titulares: 0, falta: 0, semContato: 0, emOperacao: 0 };
                                  lojasComDados.forEach(l => {
                                    totalGeral.aCaminho += l.aCaminho;
                                    totalGeral.confirmado += l.confirmado;
                                    totalGeral.emLoja += l.emLoja;
                                    totalGeral.titulares += l.titulares;
                                    totalGeral.falta += l.falta;
                                    totalGeral.semContato += l.semContato;
                                    totalGeral.emOperacao += l.emOperacao;
                                  });
                                  // % geral baseado em EM LOJA vs TITULARES, limitado a 100%
                                  const percGeral = totalGeral.titulares > 0 ? Math.min((totalGeral.emLoja / totalGeral.titulares) * 100, 100) : 0;
                                  
                                  // Ordenar conforme seleção
                                  if (ordem === 'pior') {
                                    lojasComDados.sort((a, b) => a.perc - b.perc);
                                  } else if (ordem === 'melhor') {
                                    lojasComDados.sort((a, b) => b.perc - a.perc);
                                  } else if (ordem === 'alfa') {
                                    lojasComDados.sort((a, b) => a.nome.localeCompare(b.nome));
                                  }
                                  
                                  // Renderizar por região ou flat
                                  if (ordem === 'regiao') {
                                    return (
                                      <>
                                        {regioes.map(regiao => {
                                          const lojasReg = lojasComDados.filter(l => l.regiao_id === regiao.id);
                                          if (lojasReg.length === 0) return null;
                                          
                                          return (
                                            <React.Fragment key={regiao.id}>
                                              {/* Header região */}
                                              <tr>
                                                <td colSpan="8" style={{padding: '4px 6px', border: '1px solid #cbd5e1', backgroundColor: '#e2e8f0', fontWeight: '700', color: '#1e293b', fontSize: '9px', textAlign: 'center'}}>
                                                  {regiao.nome}{regiao.gestores ? ` (${regiao.gestores})` : ''}
                                                </td>
                                              </tr>
                                              {/* Lojas */}
                                              {lojasReg.map(loja => (
                                                <tr key={loja.id} style={{backgroundColor: loja.perc < 50 ? '#fef2f2' : 'white'}}>
                                                  <td style={{padding: '2px 6px', border: '1px solid #e2e8f0', backgroundColor: loja.perc < 50 ? '#fef2f2' : '#fafafa', fontWeight: '500', whiteSpace: 'nowrap'}}>
                                                    {loja.perc < 50 && <span style={{color: '#ef4444', marginRight: '2px'}}>🔴</span>}
                                                    {loja.nome}
                                                  </td>
                                                  <td style={{padding: '2px 4px', border: '1px solid #e2e8f0', textAlign: 'center', fontWeight: '500', color: loja.aCaminho > 0 ? '#ea580c' : '#cbd5e1'}}>{loja.aCaminho}</td>
                                                  <td style={{padding: '2px 4px', border: '1px solid #e2e8f0', textAlign: 'center', fontWeight: '500', color: loja.confirmado > 0 ? '#16a34a' : '#cbd5e1'}}>{loja.confirmado}</td>
                                                  <td style={{padding: '2px 4px', border: '1px solid #e2e8f0', textAlign: 'center', fontWeight: '700', color: loja.emLoja > 0 ? '#2563eb' : '#cbd5e1'}}>{loja.emLoja}</td>
                                                  <td style={{padding: '2px 4px', border: '1px solid #e2e8f0', textAlign: 'center', fontWeight: '500', color: '#64748b'}}>{loja.titulares}</td>
                                                  <td style={{padding: '2px 4px', border: '1px solid #e2e8f0', textAlign: 'center', fontWeight: '600', color: loja.falta > 0 ? '#dc2626' : '#cbd5e1'}}>{loja.falta > 0 ? -loja.falta : 0}</td>
                                                  <td style={{padding: '2px 4px', border: '1px solid #e2e8f0', textAlign: 'center', fontWeight: '500', color: loja.semContato > 0 ? '#d97706' : '#cbd5e1'}}>{loja.semContato}</td>
                                                  <td style={{padding: '2px 4px', border: '1px solid #e2e8f0', textAlign: 'center', fontWeight: '700', backgroundColor: loja.perc < 50 ? '#fecaca' : loja.perc < 80 ? '#fde68a' : loja.perc >= 100 ? '#bbf7d0' : '#f1f5f9', color: loja.perc < 50 ? '#b91c1c' : loja.perc < 80 ? '#a16207' : loja.perc >= 100 ? '#15803d' : '#475569'}}>{loja.perc.toFixed(0)}%</td>
                                                </tr>
                                              ))}
                                            </React.Fragment>
                                          );
                                        })}
                                        {/* TOTAL GERAL */}
                                        <tr style={{backgroundColor: '#f8fafc', borderTop: '2px solid #cbd5e1'}}>
                                          <td style={{padding: '4px 6px', border: '1px solid #e2e8f0', fontWeight: '700', fontSize: '9px', color: '#1e293b'}}>TOTAL GERAL</td>
                                          <td style={{padding: '3px 4px', border: '1px solid #e2e8f0', textAlign: 'center', fontWeight: '600', color: '#ea580c'}}>{totalGeral.aCaminho}</td>
                                          <td style={{padding: '3px 4px', border: '1px solid #e2e8f0', textAlign: 'center', fontWeight: '600', color: '#16a34a'}}>{totalGeral.confirmado}</td>
                                          <td style={{padding: '3px 4px', border: '1px solid #e2e8f0', textAlign: 'center', fontWeight: '600', color: '#2563eb'}}>{totalGeral.emLoja}</td>
                                          <td style={{padding: '3px 4px', border: '1px solid #e2e8f0', textAlign: 'center', fontWeight: '600', color: '#64748b'}}>{totalGeral.titulares}</td>
                                          <td style={{padding: '3px 4px', border: '1px solid #e2e8f0', textAlign: 'center', fontWeight: '700', color: totalGeral.falta > 0 ? '#dc2626' : '#cbd5e1'}}>{totalGeral.falta > 0 ? -totalGeral.falta : 0}</td>
                                          <td style={{padding: '3px 4px', border: '1px solid #e2e8f0', textAlign: 'center', fontWeight: '600', color: totalGeral.semContato > 0 ? '#d97706' : '#cbd5e1'}}>{totalGeral.semContato}</td>
                                          <td style={{padding: '3px 4px', border: '1px solid #e2e8f0', textAlign: 'center', fontWeight: '800', backgroundColor: percGeral < 50 ? '#fecaca' : percGeral < 80 ? '#fde68a' : percGeral >= 100 ? '#bbf7d0' : '#f1f5f9', color: percGeral < 50 ? '#b91c1c' : percGeral < 80 ? '#a16207' : percGeral >= 100 ? '#15803d' : '#475569'}}>{percGeral.toFixed(0)}%</td>
                                        </tr>
                                      </>
                                    );
                                  } else {
                                    // Ordenação flat (sem agrupar por região)
                                    return (
                                      <>
                                        {lojasComDados.map((loja, idx) => (
                                          <tr key={loja.id} style={{backgroundColor: loja.perc < 50 ? '#fef2f2' : 'white'}}>
                                            <td style={{padding: '2px 6px', border: '1px solid #e2e8f0', backgroundColor: loja.perc < 50 ? '#fef2f2' : '#fafafa', fontWeight: '500', whiteSpace: 'nowrap'}}>
                                              <span style={{color: '#94a3b8', fontSize: '8px', marginRight: '3px'}}>{idx + 1}.</span>
                                              {loja.perc < 50 && <span style={{color: '#ef4444', marginRight: '2px'}}>🔴</span>}
                                              {loja.nome}
                                              <span style={{color: '#94a3b8', fontSize: '7px', marginLeft: '3px'}}>({loja.regiao?.nome || ''})</span>
                                            </td>
                                            <td style={{padding: '2px 4px', border: '1px solid #e2e8f0', textAlign: 'center', fontWeight: '500', color: loja.aCaminho > 0 ? '#ea580c' : '#cbd5e1'}}>{loja.aCaminho}</td>
                                            <td style={{padding: '2px 4px', border: '1px solid #e2e8f0', textAlign: 'center', fontWeight: '500', color: loja.confirmado > 0 ? '#16a34a' : '#cbd5e1'}}>{loja.confirmado}</td>
                                            <td style={{padding: '2px 4px', border: '1px solid #e2e8f0', textAlign: 'center', fontWeight: '700', color: loja.emLoja > 0 ? '#2563eb' : '#cbd5e1'}}>{loja.emLoja}</td>
                                            <td style={{padding: '2px 4px', border: '1px solid #e2e8f0', textAlign: 'center', fontWeight: '500', color: '#64748b'}}>{loja.titulares}</td>
                                            <td style={{padding: '2px 4px', border: '1px solid #e2e8f0', textAlign: 'center', fontWeight: '600', color: loja.falta > 0 ? '#dc2626' : '#cbd5e1'}}>{loja.falta > 0 ? -loja.falta : 0}</td>
                                            <td style={{padding: '2px 4px', border: '1px solid #e2e8f0', textAlign: 'center', fontWeight: '500', color: loja.semContato > 0 ? '#d97706' : '#cbd5e1'}}>{loja.semContato}</td>
                                            <td style={{padding: '2px 4px', border: '1px solid #e2e8f0', textAlign: 'center', fontWeight: '700', backgroundColor: loja.perc < 50 ? '#fecaca' : loja.perc < 80 ? '#fde68a' : loja.perc >= 100 ? '#bbf7d0' : '#f1f5f9', color: loja.perc < 50 ? '#b91c1c' : loja.perc < 80 ? '#a16207' : loja.perc >= 100 ? '#15803d' : '#475569'}}>{loja.perc.toFixed(0)}%</td>
                                          </tr>
                                        ))}
                                        {/* TOTAL GERAL */}
                                        <tr style={{backgroundColor: '#f8fafc', borderTop: '2px solid #cbd5e1'}}>
                                          <td style={{padding: '4px 6px', border: '1px solid #e2e8f0', fontWeight: '700', fontSize: '9px', color: '#1e293b'}}>TOTAL GERAL</td>
                                          <td style={{padding: '3px 4px', border: '1px solid #e2e8f0', textAlign: 'center', fontWeight: '600', color: '#ea580c'}}>{totalGeral.aCaminho}</td>
                                          <td style={{padding: '3px 4px', border: '1px solid #e2e8f0', textAlign: 'center', fontWeight: '600', color: '#16a34a'}}>{totalGeral.confirmado}</td>
                                          <td style={{padding: '3px 4px', border: '1px solid #e2e8f0', textAlign: 'center', fontWeight: '600', color: '#2563eb'}}>{totalGeral.emLoja}</td>
                                          <td style={{padding: '3px 4px', border: '1px solid #e2e8f0', textAlign: 'center', fontWeight: '600', color: '#64748b'}}>{totalGeral.titulares}</td>
                                          <td style={{padding: '3px 4px', border: '1px solid #e2e8f0', textAlign: 'center', fontWeight: '700', color: totalGeral.falta > 0 ? '#dc2626' : '#cbd5e1'}}>{totalGeral.falta > 0 ? -totalGeral.falta : 0}</td>
                                          <td style={{padding: '3px 4px', border: '1px solid #e2e8f0', textAlign: 'center', fontWeight: '600', color: totalGeral.semContato > 0 ? '#d97706' : '#cbd5e1'}}>{totalGeral.semContato}</td>
                                          <td style={{padding: '3px 4px', border: '1px solid #e2e8f0', textAlign: 'center', fontWeight: '800', backgroundColor: percGeral < 50 ? '#fecaca' : percGeral < 80 ? '#fde68a' : percGeral >= 100 ? '#bbf7d0' : '#f1f5f9', color: percGeral < 50 ? '#b91c1c' : percGeral < 80 ? '#a16207' : percGeral >= 100 ? '#15803d' : '#475569'}}>{percGeral.toFixed(0)}%</td>
                                        </tr>
                                      </>
                                    );
                                  }
                                })()}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      )}
                      
                      {/* ===== SUB-ABA RELATÓRIOS ===== */}
                      {dispSubTab === 'relatorios' && (
                        <div className="space-y-4">
                          {formData.relatoriosLoading ? (
                            <div className="flex items-center justify-center py-12">
                              <div className="text-center">
                                <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-purple-600 mx-auto"></div>
                                <p className="mt-4 text-gray-600">Carregando relatórios...</p>
                              </div>
                            </div>
                          ) : (
                            <>
                              {/* === COMPARATIVO HOJE vs ONTEM vs SEMANA === */}
                              <div className="bg-white rounded-xl shadow p-4">
                                <h3 className="font-bold text-gray-800 mb-3">📊 Comparativo</h3>
                                <div className="grid grid-cols-3 gap-4">
                                  {[
                                    { key: 'hoje', data: formData.relatoriosData?.comparativo?.hoje, color: 'blue' },
                                    { key: 'ontem', data: formData.relatoriosData?.comparativo?.ontem, color: 'gray' },
                                    { key: 'semanaPassada', data: formData.relatoriosData?.comparativo?.semanaPassada, color: 'purple' }
                                  ].map(item => {
                                    const labels = formData.relatoriosData?.comparativo?.labels || {};
                                    const label = labels[item.key] || (item.key === 'hoje' ? 'MAIS RECENTE' : item.key === 'ontem' ? 'ANTERIOR' : '3º ANTERIOR');
                                    return (
                                    <div key={item.key} className={`p-4 rounded-lg bg-${item.color}-50 border border-${item.color}-200`}>
                                      <h4 className={`font-bold text-${item.color}-800 text-center mb-2`}>{label}</h4>
                                      {item.data ? (
                                        <div className="space-y-1 text-sm">
                                          <div className="flex justify-between">
                                            <span>% EM LOJA:</span>
                                            <span className={`font-bold ${item.data.perc >= 80 ? 'text-green-600' : item.data.perc >= 50 ? 'text-yellow-600' : 'text-red-600'}`}>
                                              {item.data.perc}%
                                            </span>
                                          </div>
                                          <div className="flex justify-between">
                                            <span>Em Loja:</span>
                                            <span className="font-bold text-blue-600">{item.data.emLoja || 0}</span>
                                          </div>
                                          <div className="flex justify-between">
                                            <span>Titulares:</span>
                                            <span className="font-bold">{item.data.titulares || 0}</span>
                                          </div>
                                          <div className="flex justify-between">
                                            <span>Faltando:</span>
                                            <span className="font-bold text-red-600">{item.data.faltando || 0}</span>
                                          </div>
                                          <div className="flex justify-between">
                                            <span>Sem Contato:</span>
                                            <span className="font-bold text-orange-600">{item.data.semContato || 0}</span>
                                          </div>
                                        </div>
                                      ) : (
                                        <p className="text-gray-400 text-center text-sm">Sem dados</p>
                                      )}
                                    </div>
                                  )})}
                                </div>
                                
                                {/* Variação */}
                                {formData.relatoriosData?.comparativo?.hoje && formData.relatoriosData?.comparativo?.ontem && (
                                  <div className="mt-3 flex justify-center gap-4 text-sm">
                                    <span className="px-3 py-1 rounded-full bg-gray-100">
                                      vs Ontem: 
                                      <span className={`ml-1 font-bold ${(formData.relatoriosData.comparativo.hoje.perc - formData.relatoriosData.comparativo.ontem.perc) >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                                        {(formData.relatoriosData.comparativo.hoje.perc - formData.relatoriosData.comparativo.ontem.perc) >= 0 ? '+' : ''}
                                        {(formData.relatoriosData.comparativo.hoje.perc - formData.relatoriosData.comparativo.ontem.perc).toFixed(1)}%
                                      </span>
                                    </span>
                                    {formData.relatoriosData?.comparativo?.semanaPassada && (
                                      <span className="px-3 py-1 rounded-full bg-gray-100">
                                        vs Semana: 
                                        <span className={`ml-1 font-bold ${(formData.relatoriosData.comparativo.hoje.perc - formData.relatoriosData.comparativo.semanaPassada.perc) >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                                          {(formData.relatoriosData.comparativo.hoje.perc - formData.relatoriosData.comparativo.semanaPassada.perc) >= 0 ? '+' : ''}
                                          {(formData.relatoriosData.comparativo.hoje.perc - formData.relatoriosData.comparativo.semanaPassada.perc).toFixed(1)}%
                                        </span>
                                      </span>
                                    )}
                                  </div>
                                )}
                              </div>
                              
                              {/* === GRÁFICO DE MÉTRICAS (últimos 7 dias) === */}
                              <div className="bg-white rounded-xl shadow p-4">
                                <h3 className="font-bold text-gray-800 mb-3">📈 Evolução % EM LOJA (7 dias)</h3>
                                {(() => {
                                  const metricas = Array.isArray(formData.relatoriosData?.metricas) ? formData.relatoriosData.metricas : [];
                                  if (metricas.length === 0) {
                                    return <p className="text-gray-400 text-center py-8">Sem dados históricos. Salve espelhos diários para ver o gráfico.</p>;
                                  }
                                  return (
                                    <div className="h-48 flex items-end gap-2 justify-around bg-gray-50 rounded-lg p-4">
                                      {metricas.slice(0, 7).reverse().map((dia, idx) => {
                                        // Extrair data sem problema de timezone
                                        let dataFormatada = '-';
                                        if (dia.data) {
                                          const dataStr = dia.data.split('T')[0]; // "2025-12-03"
                                          const [ano, mes, diaNum] = dataStr.split('-');
                                          dataFormatada = `${diaNum}/${mes}`;
                                        }
                                        const perc = dia.percOperacao || 0;
                                        const altura = Math.max(10, perc);
                                        return (
                                          <div key={idx} className="flex flex-col items-center flex-1">
                                            <span className="text-xs font-bold mb-1">{perc}%</span>
                                            <div 
                                              className={`w-full rounded-t-lg transition-all ${
                                                perc >= 80 ? 'bg-green-500' : 
                                                perc >= 50 ? 'bg-yellow-500' : 'bg-red-500'
                                              }`}
                                              style={{ height: `${altura * 1.5}px`, maxHeight: '140px' }}
                                            ></div>
                                            <span className="text-[10px] text-gray-500 mt-1">{dataFormatada}</span>
                                            <span className="text-[9px] text-blue-600">{dia.emLoja || 0} em loja</span>
                                          </div>
                                        );
                                      })}
                                    </div>
                                  );
                                })()}
                              </div>
                              
                              {/* === RANKINGS (lado a lado) === */}
                              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                {/* Ranking de Lojas */}
                                <div className="bg-white rounded-xl shadow p-4">
                                  <h3 className="font-bold text-gray-800 mb-3">🏆 Ranking de Lojas (7 dias)</h3>
                                  <div className="space-y-1 max-h-64 overflow-y-auto">
                                    {(() => {
                                      const lojas = Array.isArray(formData.relatoriosData?.rankingLojas) ? formData.relatoriosData.rankingLojas : [];
                                      if (lojas.length === 0) return <p className="text-gray-400 text-center py-4">Sem dados de lojas</p>;
                                      return (
                                        <>
                                          {/* Top 5 Melhores */}
                                          <p className="text-xs font-semibold text-green-700 mb-1">✅ TOP 5 MELHORES</p>
                                          {lojas.slice(0, 5).map((loja, idx) => (
                                            <div key={loja.loja_id || idx} className="flex items-center gap-2 p-1.5 bg-green-50 rounded text-xs">
                                              <span className="font-bold text-green-700 w-5">{idx + 1}º</span>
                                              <span className="flex-1 truncate">{loja.loja_nome || '-'}</span>
                                              <span className="text-gray-500 text-[10px]">{loja.regiao_nome || ''}</span>
                                              <span className="font-bold text-green-700">{loja.mediaPerc || 0}%</span>
                                            </div>
                                          ))}
                                          
                                          {/* Top 5 Piores */}
                                          {lojas.length > 5 && (
                                            <>
                                              <p className="text-xs font-semibold text-red-700 mt-3 mb-1">⚠️ TOP 5 PIORES</p>
                                              {lojas.slice(-5).reverse().map((loja, idx) => (
                                                <div key={`worst-${loja.loja_id || idx}`} className="flex items-center gap-2 p-1.5 bg-red-50 rounded text-xs">
                                                  <span className="font-bold text-red-700 w-5">{lojas.length - 4 + idx}º</span>
                                                  <span className="flex-1 truncate">{loja.loja_nome || '-'}</span>
                                                  <span className="text-gray-500 text-[10px]">{loja.regiao_nome || ''}</span>
                                                  <span className="font-bold text-red-700">{loja.mediaPerc || 0}%</span>
                                                </div>
                                              ))}
                                            </>
                                          )}
                                        </>
                                      );
                                    })()}
                                  </div>
                                </div>
                                
                                {/* Ranking de Faltosos */}
                                <div className="bg-white rounded-xl shadow p-4">
                                  <h3 className="font-bold text-gray-800 mb-3">🚫 Ranking de Faltosos (30 dias)</h3>
                                  <div className="space-y-1 max-h-64 overflow-y-auto">
                                    {(() => {
                                      const faltosos = Array.isArray(formData.relatoriosData?.rankingFaltosos) ? formData.relatoriosData.rankingFaltosos : [];
                                      if (faltosos.length === 0) return <p className="text-gray-400 text-center py-4">Nenhuma falta registrada</p>;
                                      return faltosos.slice(0, 10).map((prof, idx) => (
                                        <div key={prof.cod || prof.nome || idx} className="flex items-center gap-2 p-1.5 bg-red-50 rounded text-xs">
                                          <span className="font-bold text-red-700 w-5">{idx + 1}º</span>
                                          <span className="font-mono text-gray-600 w-12">{prof.cod || '-'}</span>
                                          <span className="flex-1 truncate">{prof.nome || 'Sem nome'}</span>
                                          <span className="text-gray-500 text-[10px] truncate max-w-20">{prof.loja_nome || ''}</span>
                                          <span className="font-bold text-red-700 bg-red-200 px-1.5 rounded">{prof.totalFaltas || 0}x</span>
                                        </div>
                                      ));
                                    })()}
                                  </div>
                                </div>
                              </div>
                              
                              {/* === HEATMAP === */}
                              <div className="bg-white rounded-xl shadow p-4">
                                <h3 className="font-bold text-gray-800 mb-3">🔥 Heatmap de Faltas por Dia da Semana (30 dias)</h3>
                                {(() => {
                                  const heatmap = formData.relatoriosData?.heatmap || {};
                                  const lojas = Array.isArray(heatmap.lojas) ? heatmap.lojas : [];
                                  const diasSemana = Array.isArray(heatmap.diasSemana) ? heatmap.diasSemana : ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
                                  
                                  if (lojas.length === 0) {
                                    return <p className="text-gray-400 text-center py-4">Sem dados de faltas para gerar heatmap</p>;
                                  }
                                  
                                  return (
                                    <div className="overflow-x-auto">
                                      <table className="w-full text-xs">
                                        <thead>
                                          <tr className="bg-gray-100">
                                            <th className="px-2 py-1 text-left">Loja</th>
                                            {diasSemana.map((dia, idx) => (
                                              <th key={idx} className="px-2 py-1 text-center w-12">{dia}</th>
                                            ))}
                                            <th className="px-2 py-1 text-center">Total</th>
                                          </tr>
                                        </thead>
                                        <tbody>
                                          {lojas.slice(0, 15).map((loja, lojaIdx) => {
                                            const dias = Array.isArray(loja.dias) ? loja.dias : [0,0,0,0,0,0,0];
                                            const total = dias.reduce((a, b) => a + b, 0);
                                            const maxFaltas = Math.max(...dias, 1);
                                            return (
                                              <tr key={loja.loja_nome || lojaIdx} className="border-t">
                                                <td className="px-2 py-1 font-medium truncate max-w-32">{loja.loja_nome || '-'}</td>
                                                {dias.map((qtd, idx) => {
                                                  const intensidade = qtd / maxFaltas;
                                                  const bg = qtd === 0 ? 'bg-gray-50' : 
                                                    intensidade >= 0.8 ? 'bg-red-500 text-white' :
                                                    intensidade >= 0.5 ? 'bg-orange-400 text-white' :
                                                    intensidade >= 0.3 ? 'bg-yellow-300' : 'bg-yellow-100';
                                                  return (
                                                    <td key={idx} className={`px-2 py-1 text-center font-bold ${bg}`}>
                                                      {qtd || '-'}
                                                    </td>
                                                  );
                                                })}
                                                <td className="px-2 py-1 text-center font-bold bg-gray-200">{total}</td>
                                              </tr>
                                            );
                                          })}
                                        </tbody>
                                      </table>
                                    </div>
                                  );
                                })()}
                                <div className="flex justify-center gap-2 mt-3 text-[10px]">
                                  <span className="px-2 py-0.5 bg-gray-50 rounded">0</span>
                                  <span className="px-2 py-0.5 bg-yellow-100 rounded">Baixo</span>
                                  <span className="px-2 py-0.5 bg-yellow-300 rounded">Médio</span>
                                  <span className="px-2 py-0.5 bg-orange-400 text-white rounded">Alto</span>
                                  <span className="px-2 py-0.5 bg-red-500 text-white rounded">Crítico</span>
                                </div>
                              </div>
                            </>
                          )}
                        </div>
                      )}
                      
                      {/* ===== SUB-ABA MOTOBOYS ===== */}
                      {dispSubTab === 'motoboys' && (
                        <div className="space-y-4">
                          <div className="bg-white rounded-xl shadow p-4">
                            <h3 className="font-bold text-gray-800 mb-4">🏍️ Histórico de Motoboys</h3>
                            
                            {/* Filtros */}
                            <div className="flex flex-wrap gap-3 mb-4">
                              <div className="flex-1 min-w-[200px]">
                                <input
                                  type="text"
                                  placeholder="🔍 Buscar por código ou nome..."
                                  value={formData.motoboysBusca || ''}
                                  onChange={(e) => setFormData(f => ({...f, motoboysBusca: e.target.value}))}
                                  className="w-full px-3 py-2 border rounded-lg text-sm"
                                />
                              </div>
                              <select
                                value={formData.motoboysLojaFiltro || ''}
                                onChange={(e) => setFormData(f => ({...f, motoboysLojaFiltro: e.target.value}))}
                                className="px-3 py-2 border rounded-lg text-sm"
                              >
                                <option value="">📍 Todas as Lojas</option>
                                {(dispData.lojas || []).map(loja => (
                                  <option key={loja.id} value={loja.id}>{loja.codigo} - {loja.nome}</option>
                                ))}
                              </select>
                              <select
                                value={formData.motoboysDias || 30}
                                onChange={(e) => setFormData(f => ({...f, motoboysDias: parseInt(e.target.value)}))}
                                className="px-3 py-2 border rounded-lg text-sm"
                              >
                                <option value={7}>Últimos 7 dias</option>
                                <option value={15}>Últimos 15 dias</option>
                                <option value={30}>Últimos 30 dias</option>
                                <option value={60}>Últimos 60 dias</option>
                                <option value={90}>Últimos 90 dias</option>
                              </select>
                              <button
                                onClick={async () => {
                                  setFormData(f => ({...f, motoboysLoading: true}));
                                  try {
                                    const params = new URLSearchParams();
                                    params.append('dias', formData.motoboysDias || 30);
                                    if (formData.motoboysLojaFiltro) params.append('loja_id', formData.motoboysLojaFiltro);
                                    if (formData.motoboysBusca) params.append('busca', formData.motoboysBusca);
                                    
                                    const res = await fetch(`${API_URL}/disponibilidade/motoboys?${params}`);
                                    const data = await res.json();
                                    setFormData(f => ({...f, motoboysList: data, motoboysLoading: false}));
                                  } catch (err) {
                                    console.error('Erro ao buscar motoboys:', err);
                                    showToast('Erro ao buscar motoboys', 'error');
                                    setFormData(f => ({...f, motoboysLoading: false}));
                                  }
                                }}
                                className="px-4 py-2 bg-purple-600 text-white rounded-lg font-semibold hover:bg-purple-700"
                              >
                                🔍 Buscar
                              </button>
                            </div>
                            
                            {/* Loading */}
                            {formData.motoboysLoading && (
                              <div className="flex items-center justify-center py-8">
                                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-purple-600"></div>
                                <span className="ml-3 text-gray-600">Carregando...</span>
                              </div>
                            )}
                            
                            {/* Resultado */}
                            {!formData.motoboysLoading && formData.motoboysList && (
                              <div>
                                {/* Resumo */}
                                <div className="mb-4 p-3 bg-gray-100 rounded-lg flex items-center justify-between">
                                  <span className="text-sm text-gray-700">
                                    <strong>{formData.motoboysList.total || 0}</strong> motoboys encontrados 
                                    (últimos <strong>{formData.motoboysList.periodo_dias}</strong> dias)
                                  </span>
                                </div>
                                
                                {/* Tabela */}
                                <div className="overflow-x-auto">
                                  <table className="w-full text-xs border-collapse">
                                    <thead>
                                      <tr className="bg-gray-800 text-white">
                                        <th className="px-2 py-2 text-left">COD</th>
                                        <th className="px-2 py-2 text-left">NOME</th>
                                        <th className="px-2 py-2 text-left">LOJA ATUAL</th>
                                        <th className="px-2 py-2 text-center bg-green-700">🏪 EM LOJA</th>
                                        <th className="px-2 py-2 text-center bg-red-700">❌ FALTAS</th>
                                        <th className="px-2 py-2 text-center bg-orange-600">📵 S/ CONTATO</th>
                                        <th className="px-2 py-2 text-left">LOJAS ONDE RODOU</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {(formData.motoboysList.motoboys || []).map((mb, idx) => (
                                        <tr key={mb.cod} className={`border-b ${idx % 2 === 0 ? 'bg-white' : 'bg-gray-50'} hover:bg-blue-50`}>
                                          <td className="px-2 py-2 font-mono font-bold text-purple-700">{mb.cod}</td>
                                          <td className="px-2 py-2 font-semibold">{mb.nome || '-'}</td>
                                          <td className="px-2 py-2">
                                            {mb.loja_atual ? (
                                              <span className="text-gray-700">
                                                <span className="font-semibold">{mb.loja_atual.codigo}</span> - {mb.loja_atual.nome}
                                                {mb.loja_atual.regiao_nome && (
                                                  <span className="text-gray-400 text-[10px] ml-1">({mb.loja_atual.regiao_nome})</span>
                                                )}
                                              </span>
                                            ) : '-'}
                                          </td>
                                          <td className="px-2 py-2 text-center">
                                            <span className={`font-bold ${mb.estatisticas.em_loja.total > 0 ? 'text-green-600' : 'text-gray-400'}`}>
                                              {mb.estatisticas.em_loja.total}x
                                            </span>
                                            {mb.estatisticas.em_loja.ultima_vez && (
                                              <span className="text-[9px] text-gray-400 block">
                                                últ: {new Date(mb.estatisticas.em_loja.ultima_vez).toLocaleDateString('pt-BR', {day: '2-digit', month: '2-digit'})}
                                              </span>
                                            )}
                                          </td>
                                          <td className="px-2 py-2 text-center">
                                            <span className={`font-bold ${mb.estatisticas.faltas.total > 0 ? 'text-red-600' : 'text-gray-400'}`}>
                                              {mb.estatisticas.faltas.total}x
                                            </span>
                                            {mb.estatisticas.faltas.ultima_falta && (
                                              <span className="text-[9px] text-gray-400 block">
                                                últ: {new Date(mb.estatisticas.faltas.ultima_falta).toLocaleDateString('pt-BR', {day: '2-digit', month: '2-digit'})}
                                              </span>
                                            )}
                                          </td>
                                          <td className="px-2 py-2 text-center">
                                            <span className={`font-bold ${mb.estatisticas.sem_contato.total > 0 ? 'text-orange-600' : 'text-gray-400'}`}>
                                              {mb.estatisticas.sem_contato.total}x
                                            </span>
                                            {mb.estatisticas.sem_contato.max_dias_consecutivos > 0 && (
                                              <span className="text-[9px] text-orange-500 block">
                                                máx: {mb.estatisticas.sem_contato.max_dias_consecutivos} dias seg.
                                              </span>
                                            )}
                                          </td>
                                          <td className="px-2 py-2">
                                            {mb.lojas_rodou && mb.lojas_rodou.length > 0 ? (
                                              <div className="flex flex-wrap gap-1">
                                                {mb.lojas_rodou.slice(0, 3).map(l => (
                                                  <span key={l.id} className="px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded text-[10px]">
                                                    {l.codigo}
                                                  </span>
                                                ))}
                                                {mb.lojas_rodou.length > 3 && (
                                                  <span className="px-1.5 py-0.5 bg-gray-200 text-gray-600 rounded text-[10px]">
                                                    +{mb.lojas_rodou.length - 3}
                                                  </span>
                                                )}
                                              </div>
                                            ) : (
                                              <span className="text-gray-400">-</span>
                                            )}
                                          </td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                                
                                {/* Mensagem se não houver resultados */}
                                {(!formData.motoboysList.motoboys || formData.motoboysList.motoboys.length === 0) && (
                                  <div className="text-center py-8 text-gray-500">
                                    <p className="text-4xl mb-2">🏍️</p>
                                    <p>Nenhum motoboy encontrado com os filtros selecionados.</p>
                                  </div>
                                )}
                              </div>
                            )}
                            
                            {/* Mensagem inicial */}
                            {!formData.motoboysLoading && !formData.motoboysList && (
                              <div className="text-center py-8 text-gray-500">
                                <p className="text-4xl mb-2">🔍</p>
                                <p>Use os filtros acima e clique em "Buscar" para ver o histórico dos motoboys.</p>
                              </div>
                            )}
                          </div>
                          
                          {/* Legenda */}
                          <div className="bg-white rounded-xl shadow p-4">
                            <h4 className="font-semibold text-gray-700 mb-2 text-sm">📊 Legenda das Estatísticas</h4>
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
                              <div className="flex items-center gap-2">
                                <span className="w-3 h-3 bg-green-500 rounded"></span>
                                <span><strong>EM LOJA:</strong> Quantas vezes recebeu status "EM LOJA" (trabalhou)</span>
                              </div>
                              <div className="flex items-center gap-2">
                                <span className="w-3 h-3 bg-red-500 rounded"></span>
                                <span><strong>FALTAS:</strong> Quantas vezes foi marcado como "FALTANDO"</span>
                              </div>
                              <div className="flex items-center gap-2">
                                <span className="w-3 h-3 bg-orange-500 rounded"></span>
                                <span><strong>S/ CONTATO:</strong> Quantas vezes ficou "SEM CONTATO"</span>
                              </div>
                            </div>
                          </div>
                        </div>
                      )}
                      
                      {/* ===== SUB-ABA RESTRIÇÕES ===== */}
                      {dispSubTab === 'restricoes' && (
                        <div className="space-y-4">
                          {/* Formulário para adicionar restrição */}
                          <div className="bg-white rounded-xl shadow p-4">
                            <h3 className="font-bold text-gray-800 mb-4">🚫 Cadastrar Nova Restrição</h3>
                            
                            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
                              {/* Código do Motoboy */}
                              <div>
                                <label className="block text-sm font-semibold text-gray-700 mb-1">Código *</label>
                                <input
                                  type="text"
                                  placeholder="Ex: 12345"
                                  value={formData.restricaoCod || ''}
                                  onChange={(e) => {
                                    const cod = e.target.value;
                                    setFormData(f => ({...f, restricaoCod: cod}));
                                    // Buscar nome automaticamente
                                    const prof = profissionaisSheet.find(p => p.codigo === cod);
                                    if (prof) {
                                      setFormData(f => ({...f, restricaoNome: prof.nome}));
                                    }
                                  }}
                                  className="w-full px-3 py-2 border rounded-lg text-sm"
                                />
                              </div>
                              
                              {/* Nome (auto-preenchido) */}
                              <div>
                                <label className="block text-sm font-semibold text-gray-700 mb-1">Nome</label>
                                <input
                                  type="text"
                                  placeholder="Auto-preenchido"
                                  value={formData.restricaoNome || ''}
                                  onChange={(e) => setFormData(f => ({...f, restricaoNome: e.target.value}))}
                                  className="w-full px-3 py-2 border rounded-lg text-sm bg-gray-50"
                                />
                              </div>
                              
                              {/* Loja */}
                              <div>
                                <label className="block text-sm font-semibold text-gray-700 mb-1">Loja</label>
                                <select
                                  value={formData.restricaoTodasLojas ? 'TODAS' : (formData.restricaoLojaId || '')}
                                  onChange={(e) => {
                                    if (e.target.value === 'TODAS') {
                                      setFormData(f => ({...f, restricaoTodasLojas: true, restricaoLojaId: ''}));
                                    } else {
                                      setFormData(f => ({...f, restricaoTodasLojas: false, restricaoLojaId: e.target.value}));
                                    }
                                  }}
                                  className="w-full px-3 py-2 border rounded-lg text-sm"
                                >
                                  <option value="">Selecione uma loja...</option>
                                  <option value="TODAS" className="font-bold text-red-600">🚫 TODAS AS LOJAS</option>
                                  {(dispData.lojas || []).map(loja => (
                                    <option key={loja.id} value={loja.id}>{loja.codigo} - {loja.nome}</option>
                                  ))}
                                </select>
                              </div>
                              
                              {/* Motivo */}
                              <div>
                                <label className="block text-sm font-semibold text-gray-700 mb-1">Motivo *</label>
                                <input
                                  type="text"
                                  placeholder="Ex: Comportamento inadequado"
                                  value={formData.restricaoMotivo || ''}
                                  onChange={(e) => setFormData(f => ({...f, restricaoMotivo: e.target.value}))}
                                  className="w-full px-3 py-2 border rounded-lg text-sm"
                                />
                              </div>
                            </div>
                            
                            <button
                              onClick={async () => {
                                if (!formData.restricaoCod || !formData.restricaoMotivo) {
                                  showToast('Preencha o código e o motivo', 'error');
                                  return;
                                }
                                if (!formData.restricaoTodasLojas && !formData.restricaoLojaId) {
                                  showToast('Selecione uma loja ou "Todas as Lojas"', 'error');
                                  return;
                                }
                                
                                try {
                                  const res = await fetch(`${API_URL}/disponibilidade/restricoes`, {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({
                                      cod_profissional: formData.restricaoCod,
                                      nome_profissional: formData.restricaoNome,
                                      loja_id: formData.restricaoLojaId || null,
                                      todas_lojas: formData.restricaoTodasLojas || false,
                                      motivo: formData.restricaoMotivo,
                                      criado_por: user?.fullName || user?.username
                                    })
                                  });
                                  
                                  if (!res.ok) {
                                    const err = await res.json();
                                    throw new Error(err.error || 'Erro ao cadastrar');
                                  }
                                  
                                  showToast('✅ Restrição cadastrada com sucesso!', 'success');
                                  
                                  // Limpar formulário
                                  setFormData(f => ({
                                    ...f, 
                                    restricaoCod: '', 
                                    restricaoNome: '', 
                                    restricaoLojaId: '',
                                    restricaoTodasLojas: false,
                                    restricaoMotivo: ''
                                  }));
                                  
                                  // Recarregar lista
                                  const listRes = await fetch(`${API_URL}/disponibilidade/restricoes`);
                                  const listData = await listRes.json();
                                  setFormData(f => ({...f, restricoesList: listData}));
                                } catch (err) {
                                  showToast(err.message, 'error');
                                }
                              }}
                              className="px-6 py-2 bg-red-600 text-white rounded-lg font-semibold hover:bg-red-700"
                            >
                              🚫 Cadastrar Restrição
                            </button>
                          </div>
                          
                          {/* Lista de Restrições */}
                          <div className="bg-white rounded-xl shadow p-4">
                            <h3 className="font-bold text-gray-800 mb-4">
                              📋 Restrições Ativas ({(formData.restricoesList || []).length})
                            </h3>
                            
                            {formData.restricoesLoading ? (
                              <div className="flex items-center justify-center py-8">
                                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-red-600"></div>
                                <span className="ml-3 text-gray-600">Carregando...</span>
                              </div>
                            ) : (formData.restricoesList || []).length === 0 ? (
                              <div className="text-center py-8 text-gray-500">
                                <p className="text-4xl mb-2">✅</p>
                                <p>Nenhuma restrição ativa no momento.</p>
                              </div>
                            ) : (
                              <div className="overflow-x-auto">
                                <table className="w-full text-xs border-collapse">
                                  <thead>
                                    <tr className="bg-red-700 text-white">
                                      <th className="px-2 py-2 text-left">COD</th>
                                      <th className="px-2 py-2 text-left">NOME</th>
                                      <th className="px-2 py-2 text-left">LOJA</th>
                                      <th className="px-2 py-2 text-left">MOTIVO</th>
                                      <th className="px-2 py-2 text-left">CRIADO POR</th>
                                      <th className="px-2 py-2 text-left">DATA</th>
                                      <th className="px-2 py-2 text-center">AÇÃO</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {(formData.restricoesList || []).map((r, idx) => (
                                      <tr key={r.id} className={`border-b ${idx % 2 === 0 ? 'bg-white' : 'bg-red-50'} hover:bg-red-100`}>
                                        <td className="px-2 py-2 font-mono font-bold text-red-700">{r.cod_profissional}</td>
                                        <td className="px-2 py-2 font-semibold">{r.nome_profissional || '-'}</td>
                                        <td className="px-2 py-2">
                                          {r.todas_lojas ? (
                                            <span className="px-2 py-0.5 bg-red-600 text-white rounded text-[10px] font-bold">
                                              🚫 TODAS
                                            </span>
                                          ) : r.loja_nome ? (
                                            <span>{r.loja_codigo} - {r.loja_nome}</span>
                                          ) : '-'}
                                        </td>
                                        <td className="px-2 py-2 max-w-[200px] truncate" title={r.motivo}>{r.motivo}</td>
                                        <td className="px-2 py-2 text-gray-600">{r.criado_por || '-'}</td>
                                        <td className="px-2 py-2 text-gray-600">
                                          {new Date(r.created_at).toLocaleDateString('pt-BR')}
                                        </td>
                                        <td className="px-2 py-2 text-center">
                                          <button
                                            onClick={async () => {
                                              if (!confirm(`Remover restrição de ${r.cod_profissional} - ${r.nome_profissional || 'N/A'}?`)) return;
                                              
                                              try {
                                                await fetch(`${API_URL}/disponibilidade/restricoes/${r.id}`, { method: 'DELETE' });
                                                showToast('✅ Restrição removida!', 'success');
                                                
                                                // Recarregar lista
                                                const listRes = await fetch(`${API_URL}/disponibilidade/restricoes`);
                                                const listData = await listRes.json();
                                                setFormData(f => ({...f, restricoesList: listData}));
                                              } catch (err) {
                                                showToast('Erro ao remover restrição', 'error');
                                              }
                                            }}
                                            className="px-2 py-1 bg-green-600 text-white rounded text-[10px] font-bold hover:bg-green-700"
                                          >
                                            ✅ Liberar
                                          </button>
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                      
                      {/* ===== SUB-ABA CONFIG ===== */}
                      {dispSubTab === 'config' && (
                        <div className="space-y-4">
                          {/* Link Público */}
                          <div className="bg-white rounded-xl shadow p-4">
                            <h3 className="font-bold text-gray-800 mb-3">🔗 Link Público (Somente Leitura)</h3>
                            <p className="text-sm text-gray-600 mb-3">
                              Compartilhe este link com gestores para visualizar o panorama em tempo real, sem precisar de login.
                              A página atualiza automaticamente a cada 2 minutos.
                            </p>
                            <div className="flex gap-2 flex-wrap">
                              <input 
                                type="text" 
                                readOnly
                                value={`${API_URL}/disponibilidade/publico`}
                                className="flex-1 px-3 py-2 bg-gray-100 border rounded-lg text-sm font-mono"
                              />
                              <button 
                                onClick={() => {
                                  navigator.clipboard.writeText(`${API_URL}/disponibilidade/publico`);
                                  showToast('✅ Link copiado!', 'success');
                                }}
                                className="px-4 py-2 bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700"
                              >
                                📋 Copiar Link
                              </button>
                              <button 
                                onClick={() => window.open(`${API_URL}/disponibilidade/publico`, '_blank')}
                                className="px-4 py-2 bg-green-600 text-white rounded-lg font-semibold hover:bg-green-700"
                              >
                                🔗 Abrir
                              </button>
                            </div>
                          </div>
                          
                          {/* Adicionar Região */}
                          <div className="bg-white rounded-xl shadow p-4">
                            <h3 className="font-bold text-gray-800 mb-3">🌍 Regiões</h3>
                            <div className="flex gap-2 mb-4">
                              <input 
                                type="text" 
                                placeholder="Nome da região (ex: GOIÂNIA)" 
                                value={formData.novaRegiao || ''} 
                                onChange={e => setFormData({...formData, novaRegiao: e.target.value.toUpperCase()})}
                                className="flex-1 px-3 py-2 border rounded-lg"
                                onKeyPress={e => e.key === 'Enter' && addRegiao()}
                              />
                              <button onClick={addRegiao} className="px-4 py-2 bg-purple-600 text-white rounded-lg font-semibold hover:bg-purple-700">
                                + Adicionar
                              </button>
                            </div>
                            
                            {/* Lista de Regiões com gestores */}
                            <div className="space-y-2">
                              {(dispData.regioes || []).map(r => (
                                <div key={r.id} className="flex items-center gap-2 p-2 bg-purple-50 rounded-lg">
                                  <span className="font-semibold text-purple-800 min-w-[150px]">{r.nome}</span>
                                  <input 
                                    type="text"
                                    placeholder="Gestores (ex: LIS / LEO / ERICK)"
                                    value={r.gestores || ''}
                                    onChange={async (e) => {
                                      const novoGestores = e.target.value;
                                      // Atualizar localmente
                                      const novasRegioes = dispData.regioes.map(reg => 
                                        reg.id === r.id ? {...reg, gestores: novoGestores} : reg
                                      );
                                      setFormData(f => ({...f, dispData: {...dispData, regioes: novasRegioes}}));
                                      // Salvar no banco (debounce)
                                      clearTimeout(window.gestoresDebounce);
                                      window.gestoresDebounce = setTimeout(async () => {
                                        try {
                                          await fetch(`${API_URL}/disponibilidade/regioes/${r.id}`, {
                                            method: 'PUT',
                                            headers: { 'Content-Type': 'application/json' },
                                            body: JSON.stringify({ gestores: novoGestores })
                                          });
                                        } catch (err) {
                                          console.error('Erro ao salvar gestores:', err);
                                        }
                                      }, 500);
                                    }}
                                    className="flex-1 px-2 py-1 border border-purple-200 rounded text-sm"
                                  />
                                  <button 
                                    onClick={() => removeRegiao(r.id, r.nome)} 
                                    className="text-red-600 hover:text-red-800 font-bold px-2"
                                    title="Remover região"
                                  >
                                    ×
                                  </button>
                                </div>
                              ))}
                              {(dispData.regioes || []).length === 0 && <p className="text-gray-500 text-sm">Nenhuma região cadastrada</p>}
                            </div>
                          </div>
                          
                          {/* Adicionar Loja */}
                          <div className="bg-white rounded-xl shadow p-4">
                            <h3 className="font-bold text-gray-800 mb-3">🏪 Adicionar Loja</h3>
                            <div className="grid grid-cols-1 md:grid-cols-6 gap-3">
                              <select 
                                value={formData.novaLojaRegiaoId || ''} 
                                onChange={e => setFormData({...formData, novaLojaRegiaoId: e.target.value})}
                                className="px-3 py-2 border rounded-lg"
                              >
                                <option value="">Selecione a Região</option>
                                {(dispData.regioes || []).map(r => <option key={r.id} value={r.id}>{r.nome}</option>)}
                              </select>
                              <input 
                                type="text" 
                                placeholder="Código (ex: 249)" 
                                value={formData.novaCodLoja || ''} 
                                onChange={e => setFormData({...formData, novaCodLoja: e.target.value})}
                                className="px-3 py-2 border rounded-lg"
                              />
                              <input 
                                type="text" 
                                placeholder="Nome da Loja" 
                                value={formData.novaNomeLoja || ''} 
                                onChange={e => setFormData({...formData, novaNomeLoja: e.target.value.toUpperCase()})}
                                className="px-3 py-2 border rounded-lg"
                              />
                              <input 
                                type="number" 
                                placeholder="Titulares" 
                                min="0"
                                value={formData.novaQtdTitulares || ''} 
                                onChange={e => setFormData({...formData, novaQtdTitulares: e.target.value})}
                                className="px-3 py-2 border rounded-lg"
                                title="Quantidade de linhas titulares"
                              />
                              <input 
                                type="number" 
                                placeholder="Excedentes" 
                                min="0"
                                value={formData.novaQtdExcedentes || ''} 
                                onChange={e => setFormData({...formData, novaQtdExcedentes: e.target.value})}
                                className="px-3 py-2 border rounded-lg bg-red-50"
                                title="Quantidade de linhas excedentes"
                              />
                              <button onClick={addLoja} className="px-4 py-2 bg-green-600 text-white rounded-lg font-semibold hover:bg-green-700">
                                + Adicionar Loja
                              </button>
                            </div>
                            <p className="text-xs text-gray-500 mt-2">💡 Titulares = linhas principais | Excedentes = linhas extras (aparecem em vermelho claro)</p>
                          </div>
                          
                          {/* Lista de Lojas por Região */}
                          {(dispData.regioes || []).map(regiao => {
                            const lojasRegiao = (dispData.lojas || []).filter(l => l.regiao_id === regiao.id);
                            if (lojasRegiao.length === 0) return null;
                            return (
                              <div key={regiao.id} className="bg-white rounded-xl shadow p-4">
                                <h3 className="font-bold text-gray-800 mb-3">📍 {regiao.nome} {regiao.gestores && <span className="font-normal text-gray-500">({regiao.gestores})</span>}</h3>
                                <div className="overflow-x-auto">
                                  <table className="w-full text-sm">
                                    <thead className="bg-gray-100">
                                      <tr>
                                        <th className="px-3 py-2 text-left">Código</th>
                                        <th className="px-3 py-2 text-left">Nome da Loja</th>
                                        <th className="px-3 py-2 text-center">Titulares</th>
                                        <th className="px-3 py-2 text-center">Excedentes</th>
                                        <th className="px-3 py-2 text-center">Total</th>
                                        <th className="px-3 py-2 text-center">Ações</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {lojasRegiao.map(loja => {
                                        const linhasLoja = (dispData.linhas || []).filter(l => l.loja_id === loja.id);
                                        const titulares = linhasLoja.filter(l => !l.is_excedente).length;
                                        const excedentes = linhasLoja.filter(l => l.is_excedente).length;
                                        const editando = formData.editandoLoja === loja.id;
                                        
                                        return (
                                          <tr key={loja.id} className="border-t">
                                            <td className="px-3 py-2">
                                              {editando ? (
                                                <input 
                                                  type="text" 
                                                  value={formData.editLojaCodigo || ''} 
                                                  onChange={e => setFormData({...formData, editLojaCodigo: e.target.value})}
                                                  className="w-20 px-2 py-1 border rounded text-xs"
                                                />
                                              ) : (
                                                <span className="font-mono font-bold">{loja.codigo}</span>
                                              )}
                                            </td>
                                            <td className="px-3 py-2">
                                              {editando ? (
                                                <input 
                                                  type="text" 
                                                  value={formData.editLojaNome || ''} 
                                                  onChange={e => setFormData({...formData, editLojaNome: e.target.value.toUpperCase()})}
                                                  className="w-full px-2 py-1 border rounded text-xs"
                                                />
                                              ) : (
                                                loja.nome
                                              )}
                                            </td>
                                            <td className="px-3 py-2 text-center">
                                              <span className="px-2 py-0.5 bg-blue-100 text-blue-700 rounded text-xs">{titulares}</span>
                                            </td>
                                            <td className="px-3 py-2 text-center">
                                              <span className="px-2 py-0.5 bg-red-100 text-red-700 rounded text-xs">{excedentes}</span>
                                            </td>
                                            <td className="px-3 py-2 text-center font-semibold">{linhasLoja.length}</td>
                                            <td className="px-3 py-2 text-center">
                                              {editando ? (
                                                <>
                                                  <button 
                                                    onClick={async () => {
                                                      try {
                                                        await fetch(`${API_URL}/disponibilidade/lojas/${loja.id}`, {
                                                          method: 'PUT',
                                                          headers: { 'Content-Type': 'application/json' },
                                                          body: JSON.stringify({ 
                                                            codigo: formData.editLojaCodigo, 
                                                            nome: formData.editLojaNome 
                                                          })
                                                        });
                                                        setFormData({...formData, editandoLoja: null});
                                                        showToast('✅ Loja atualizada!', 'success');
                                                        loadDisponibilidade();
                                                      } catch (err) {
                                                        showToast('Erro ao atualizar', 'error');
                                                      }
                                                    }} 
                                                    className="px-2 py-1 bg-green-100 text-green-700 rounded text-xs mr-1"
                                                  >
                                                    ✓
                                                  </button>
                                                  <button 
                                                    onClick={() => setFormData({...formData, editandoLoja: null})} 
                                                    className="px-2 py-1 bg-gray-100 text-gray-700 rounded text-xs"
                                                  >
                                                    ✕
                                                  </button>
                                                </>
                                              ) : (
                                                <>
                                                  <button 
                                                    onClick={() => setFormData({...formData, editandoLoja: loja.id, editLojaCodigo: loja.codigo, editLojaNome: loja.nome})} 
                                                    className="px-2 py-1 bg-yellow-100 text-yellow-700 rounded text-xs mr-1" 
                                                    title="Editar loja"
                                                  >
                                                    ✏️
                                                  </button>
                                                  <button onClick={() => addLinhasLoja(loja.id, 1, false)} className="px-2 py-1 bg-blue-100 text-blue-700 rounded text-xs mr-1" title="Adicionar titular">+T</button>
                                                  <button onClick={() => addLinhasLoja(loja.id, 1, true)} className="px-2 py-1 bg-red-100 text-red-700 rounded text-xs mr-1" title="Adicionar excedente">+E</button>
                                                  <button onClick={() => removeLoja(loja.id, loja.nome)} className="px-2 py-1 bg-red-100 text-red-700 rounded text-xs" title="Remover loja">🗑️</button>
                                                </>
                                              )}
                                            </td>
                                          </tr>
                                        );
                                      })}
                                    </tbody>
                                  </table>
                                </div>
                              </div>
                            );
                          })}
                          
                          {/* Botão Limpar Linhas */}
                          {(dispData.linhas || []).length > 0 && (
                            <div className="bg-red-50 border border-red-200 rounded-xl p-4">
                              <div className="flex items-center justify-between">
                                <div>
                                  <h4 className="font-semibold text-red-800">🧹 Limpar Todas as Linhas</h4>
                                  <p className="text-sm text-red-600">Reseta todos os entregadores, mantém a estrutura de regiões e lojas.</p>
                                </div>
                                <button onClick={limparLinhas} className="px-4 py-2 bg-red-600 text-white rounded-lg font-semibold hover:bg-red-700">
                                  Limpar Linhas
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                      
                      {/* ===== SUB-ABA PRINCIPAL ===== */}
                      {dispSubTab === 'principal' && (
                        <div className="space-y-4">
                          {/* Header com data e botões */}
                          <div className="bg-white rounded-xl shadow p-3">
                            <div className="flex justify-between items-center flex-wrap gap-3">
                              <div className="flex items-center gap-3">
                                <h2 className="text-lg font-bold text-gray-800">📅 Disponibilidade</h2>
                                <div className="flex items-center gap-2 bg-purple-50 px-3 py-1.5 rounded-lg border border-purple-200">
                                  <span className="text-sm font-semibold text-purple-700">Data:</span>
                                  <input 
                                    type="date" 
                                    value={formData.dispDataPlanilha || new Date().toISOString().split('T')[0]} 
                                    onChange={e => setFormData({...formData, dispDataPlanilha: e.target.value})}
                                    className="px-2 py-1 border border-purple-300 rounded text-sm font-semibold text-purple-800 bg-white"
                                  />
                                </div>
                                {/* Campo de busca */}
                                <div className="flex items-center gap-2 bg-blue-50 px-3 py-1.5 rounded-lg border border-blue-200">
                                  <span className="text-blue-500">🔍</span>
                                  <input 
                                    type="text" 
                                    placeholder="Buscar código ou nome..."
                                    value={formData.buscaEntregador || ''}
                                    onChange={e => setFormData({...formData, buscaEntregador: e.target.value})}
                                    className="px-2 py-1 border border-blue-300 rounded text-sm bg-white w-48"
                                  />
                                  {formData.buscaEntregador && (
                                    <button 
                                      onClick={() => setFormData({...formData, buscaEntregador: ''})}
                                      className="text-blue-400 hover:text-blue-600"
                                    >×</button>
                                  )}
                                </div>
                              </div>
                              <div className="flex gap-2">
                                <button onClick={loadDisponibilidade} className="px-3 py-1.5 bg-gray-100 text-gray-700 rounded-lg font-semibold hover:bg-gray-200 flex items-center gap-1 text-sm">
                                  🔄 Atualizar
                                </button>
                                <button onClick={resetarStatus} className="px-3 py-1.5 bg-orange-100 text-orange-700 rounded-lg font-semibold hover:bg-orange-200 flex items-center gap-1 text-sm">
                                  🔄 Resetar Status
                                </button>
                              </div>
                            </div>
                            
                            {/* Resultados da busca */}
                            {formData.buscaEntregador && formData.buscaEntregador.length >= 2 && (
                              <div className="mt-3 p-3 bg-blue-50 rounded-lg">
                                <p className="text-xs font-semibold text-blue-700 mb-2">Resultados para "{formData.buscaEntregador}":</p>
                                <div className="space-y-1 max-h-40 overflow-y-auto">
                                  {(() => {
                                    const termo = formData.buscaEntregador.toLowerCase();
                                    const resultados = (dispData.linhas || []).filter(l => 
                                      (l.cod_profissional && l.cod_profissional.toLowerCase().includes(termo)) ||
                                      (l.nome_profissional && l.nome_profissional.toLowerCase().includes(termo))
                                    );
                                    if (resultados.length === 0) {
                                      return <p className="text-gray-500 text-sm">Nenhum resultado encontrado</p>;
                                    }
                                    return resultados.slice(0, 10).map(linha => {
                                      const loja = (dispData.lojas || []).find(l => l.id === linha.loja_id);
                                      return (
                                        <div key={linha.id} className="flex items-center justify-between p-2 bg-white rounded text-xs">
                                          <div className="flex items-center gap-2">
                                            <span className="font-mono font-bold">{linha.cod_profissional || '-'}</span>
                                            <span>{linha.nome_profissional || 'Sem nome'}</span>
                                          </div>
                                          <div className="flex items-center gap-2">
                                            <span className="text-gray-500">{loja?.nome || ''}</span>
                                            <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                                              linha.status === 'EM LOJA' ? 'bg-blue-100 text-blue-700' :
                                              linha.status === 'CONFIRMADO' ? 'bg-green-100 text-green-700' :
                                              linha.status === 'A CAMINHO' ? 'bg-orange-100 text-orange-700' :
                                              linha.status === 'FALTANDO' ? 'bg-red-100 text-red-700' :
                                              'bg-gray-100 text-gray-700'
                                            }`}>{linha.status}</span>
                                          </div>
                                        </div>
                                      );
                                    });
                                  })()}
                                </div>
                              </div>
                            )}
                          </div>
                          
                          {/* Modal de Falta */}
                          {formData.modalFaltando && (
                            <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
                              <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-md mx-4">
                                <h3 className="text-lg font-bold text-red-600 mb-4">⚠️ Registrar Falta</h3>
                                <div className="mb-4">
                                  <p className="text-sm text-gray-600 mb-2">
                                    <strong>Profissional:</strong> {formData.faltandoLinha?.nome_profissional || formData.faltandoLinha?.cod_profissional || 'Não identificado'}
                                  </p>
                                  <label className="text-sm font-semibold text-gray-700">Motivo da falta *</label>
                                  <textarea 
                                    value={formData.faltandoMotivo || ''} 
                                    onChange={e => setFormData({...formData, faltandoMotivo: e.target.value})}
                                    placeholder="Digite o motivo da falta..."
                                    className="w-full px-3 py-2 border rounded-lg mt-1 text-sm"
                                    rows={3}
                                    autoFocus
                                  />
                                </div>
                                <div className="flex gap-2">
                                  <button 
                                    onClick={() => setFormData({...formData, modalFaltando: false, faltandoLinha: null, faltandoMotivo: ''})}
                                    className="flex-1 px-4 py-2 bg-gray-100 text-gray-700 rounded-lg font-semibold hover:bg-gray-200"
                                  >
                                    Cancelar
                                  </button>
                                  <button 
                                    onClick={confirmarFalta}
                                    className="flex-1 px-4 py-2 bg-red-600 text-white rounded-lg font-semibold hover:bg-red-700"
                                  >
                                    ✓ Confirmar Falta
                                  </button>
                                </div>
                              </div>
                            </div>
                          )}
                          
                          {(dispData.regioes || []).length === 0 ? (
                            <div className="bg-white rounded-xl shadow p-8 text-center">
                              <p className="text-gray-500 text-lg">Nenhuma estrutura configurada.</p>
                              <button 
                                onClick={() => setFormData({...formData, dispSubTab: 'config'})} 
                                className="mt-4 px-6 py-2 bg-purple-600 text-white rounded-lg font-semibold"
                              >
                                ⚙️ Configurar Estrutura
                              </button>
                            </div>
                          ) : (
                            <>
                              {/* Botões de Regiões */}
                              <div className="flex flex-wrap gap-2">
                                {(dispData.regioes || []).map(regiao => {
                                  const lojasRegiao = (dispData.lojas || []).filter(l => l.regiao_id === regiao.id);
                                  const linhasRegiao = (dispData.linhas || []).filter(l => lojasRegiao.some(lj => lj.id === l.loja_id));
                                  const emLoja = linhasRegiao.filter(l => l.status === 'EM LOJA').length;
                                  const titulares = linhasRegiao.filter(l => !l.is_excedente && !l.is_reposicao).length;
                                  
                                  return (
                                    <button 
                                      key={regiao.id}
                                      onClick={() => setFormData({...formData, dispRegiaoAtiva: formData.dispRegiaoAtiva === regiao.id ? null : regiao.id})}
                                      className={`px-3 py-1.5 rounded-lg font-semibold transition-all flex items-center gap-2 text-sm ${
                                        formData.dispRegiaoAtiva === regiao.id 
                                          ? 'bg-purple-600 text-white shadow-lg' 
                                          : 'bg-white text-gray-700 border hover:bg-purple-50 hover:border-purple-300'
                                      }`}
                                    >
                                      📍 {regiao.nome}
                                      <span className={`text-xs px-2 py-0.5 rounded-full font-bold ${
                                        formData.dispRegiaoAtiva === regiao.id 
                                          ? 'bg-white/20 text-white' 
                                          : emLoja >= titulares && titulares > 0 ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'
                                      }`}>
                                        {emLoja}/{titulares}
                                      </span>
                                    </button>
                                  );
                                })}
                              </div>
                              
                              {/* Conteúdo da Região Selecionada */}
                              {formData.dispRegiaoAtiva && (() => {
                                const regiao = (dispData.regioes || []).find(r => r.id === formData.dispRegiaoAtiva);
                                if (!regiao) return null;
                                
                                const lojasRegiao = (dispData.lojas || []).filter(l => l.regiao_id === regiao.id);
                                
                                return (
                                  <div className="space-y-2">
                                    {/* Lojas como Dropdown/Acordeão */}
                                    {lojasRegiao.map(loja => {
                                      const linhasLoja = (dispData.linhas || []).filter(l => l.loja_id === loja.id);
                                      const isOpen = (formData.dispLojasAbertas || []).includes(loja.id);
                                      const emLoja = linhasLoja.filter(l => l.status === 'EM LOJA').length;
                                      const titulares = linhasLoja.filter(l => !l.is_excedente && !l.is_reposicao).length;
                                      const faltando = linhasLoja.filter(l => l.status === 'FALTANDO').length;
                                      const reposicoes = linhasLoja.filter(l => l.is_reposicao).length;
                                      
                                      // Cor do header baseada no status geral
                                      let headerColor = 'bg-gray-100 hover:bg-gray-200';
                                      if (faltando > 0) headerColor = 'bg-red-100 hover:bg-red-200';
                                      else if (emLoja >= titulares && titulares > 0) headerColor = 'bg-green-100 hover:bg-green-200';
                                      else if (emLoja > 0) headerColor = 'bg-yellow-100 hover:bg-yellow-200';
                                      
                                      return (
                                        <div key={loja.id} className="bg-white rounded-lg shadow overflow-hidden">
                                          {/* Header da Loja (clicável) */}
                                          <button 
                                            onClick={() => {
                                              const abertas = formData.dispLojasAbertas || [];
                                              if (isOpen) {
                                                setFormData({...formData, dispLojasAbertas: abertas.filter(id => id !== loja.id)});
                                              } else {
                                                setFormData({...formData, dispLojasAbertas: [...abertas, loja.id]});
                                              }
                                            }}
                                            className={`w-full px-3 py-2 flex items-center justify-between ${headerColor} transition-colors`}
                                          >
                                            <div className="flex items-center gap-2">
                                              <span className={`transform transition-transform text-xs ${isOpen ? 'rotate-90' : ''}`}>▶</span>
                                              <span className="font-mono font-bold text-purple-700 text-sm">{loja.codigo}</span>
                                              <span className="font-semibold text-gray-800 text-sm">{loja.nome}</span>
                                            </div>
                                            <div className="flex items-center gap-2">
                                              {faltando > 0 && (
                                                <span className="px-2 py-0.5 bg-red-500 text-white text-xs rounded-full font-semibold">
                                                  {faltando} faltando
                                                </span>
                                              )}
                                              <span className={`text-xs font-semibold px-2 py-0.5 rounded ${emLoja >= titulares ? 'bg-green-200 text-green-800' : 'bg-gray-200 text-gray-700'}`}>
                                                {emLoja}/{titulares} em loja
                                              </span>
                                            </div>
                                          </button>
                                          
                                          {/* Conteúdo Expandido (Linhas) */}
                                          {isOpen && (
                                            <div className="border-t" data-loja-id={loja.id}>
                                              <table className="w-full text-xs">
                                                <thead className="bg-gray-50">
                                                  <tr>
                                                    <th className="w-1"></th>
                                                    <th className="px-2 py-1 text-center w-20">COD</th>
                                                    <th className="px-2 py-1 text-left">ENTREGADOR</th>
                                                    <th className="px-2 py-1 text-center w-36">STATUS</th>
                                                    <th className="px-2 py-1 text-left">OBS</th>
                                                    <th className="px-1 py-1 text-center w-6"></th>
                                                  </tr>
                                                </thead>
                                                <tbody>
                                                  {/* Ordenar: Reposição primeiro, depois Titulares, depois Excedentes */}
                                                  {(() => {
                                                    const linhasOrdenadas = [...linhasLoja].sort((a, b) => {
                                                      if (a.is_reposicao && !b.is_reposicao) return -1;
                                                      if (!a.is_reposicao && b.is_reposicao) return 1;
                                                      if (a.is_excedente && !b.is_excedente) return 1;
                                                      if (!a.is_excedente && b.is_excedente) return -1;
                                                      return 0;
                                                    });
                                                    
                                                    return linhasOrdenadas.map((linha, indexLinha) => (
                                                    <tr key={linha.id} className={`border-t ${linha.is_reposicao ? 'bg-blue-50/50' : linha.is_excedente ? 'bg-red-50/50' : ''} ${!linha.is_excedente && !linha.is_reposicao && rowColors[linha.status] ? rowColors[linha.status] : ''} hover:bg-gray-50`}>
                                                      <td className={`w-1 ${linha.is_reposicao ? 'bg-blue-400' : linha.is_excedente ? 'bg-red-400' : ''}`}></td>
                                                      <td className="px-1 py-0.5">
                                                        <input 
                                                          type="text" 
                                                          value={linha.cod_profissional || ''} 
                                                          onChange={e => updateLinha(linha.id, 'cod_profissional', e.target.value)}
                                                          onKeyDown={e => {
                                                            // Navegação por setas
                                                            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                                                              e.preventDefault();
                                                              const inputs = document.querySelectorAll(`[data-loja-id="${loja.id}"] input[data-cod-input]`);
                                                              const currentIndex = Array.from(inputs).findIndex(inp => inp === e.target);
                                                              let nextIndex = e.key === 'ArrowDown' ? currentIndex + 1 : currentIndex - 1;
                                                              if (nextIndex >= 0 && nextIndex < inputs.length) {
                                                                inputs[nextIndex].focus();
                                                                inputs[nextIndex].select();
                                                              }
                                                            }
                                                            // Enter vai para próxima linha
                                                            if (e.key === 'Enter') {
                                                              e.preventDefault();
                                                              const inputs = document.querySelectorAll(`[data-loja-id="${loja.id}"] input[data-cod-input]`);
                                                              const currentIndex = Array.from(inputs).findIndex(inp => inp === e.target);
                                                              if (currentIndex + 1 < inputs.length) {
                                                                inputs[currentIndex + 1].focus();
                                                                inputs[currentIndex + 1].select();
                                                              }
                                                            }
                                                          }}
                                                          data-cod-input={linha.id}
                                                          placeholder="..."
                                                          className={`w-full px-1 py-0.5 border border-gray-200 rounded text-center font-mono text-xs ${linha.is_reposicao ? 'bg-blue-50/50' : linha.is_excedente ? 'bg-red-50/50' : 'bg-white'}`}
                                                        />
                                                      </td>
                                                      <td className="px-1 py-0.5">
                                                        <div className="flex items-center gap-1">
                                                          {linha.is_reposicao && <span className="text-[9px] text-blue-400 italic">reposição</span>}
                                                          {linha.is_excedente && <span className="text-[9px] text-red-400 italic">excedente</span>}
                                                          <span className={`text-xs ${linha.nome_profissional ? 'text-gray-800' : 'text-gray-400 italic'}`}>
                                                            {linha.nome_profissional || (!linha.is_reposicao && !linha.is_excedente ? '-' : '')}
                                                          </span>
                                                        </div>
                                                      </td>
                                                      <td className="px-1 py-0.5">
                                                        <select 
                                                          value={linha.status || 'A CONFIRMAR'} 
                                                          onChange={e => {
                                                            if (e.target.value === 'FALTANDO') {
                                                              marcarFaltando(linha);
                                                            } else {
                                                              updateLinha(linha.id, 'status', e.target.value);
                                                            }
                                                          }}
                                                          className={`w-full px-1 py-0.5 border border-gray-200 rounded text-xs font-semibold ${statusColors[linha.status] || ''}`}
                                                        >
                                                          <option value="A CONFIRMAR">A CONFIRMAR</option>
                                                          <option value="CONFIRMADO">CONFIRMADO</option>
                                                          <option value="A CAMINHO">A CAMINHO</option>
                                                          <option value="EM LOJA">EM LOJA</option>
                                                          <option value="FALTANDO">FALTANDO</option>
                                                          <option value="SEM CONTATO">SEM CONTATO</option>
                                                        </select>
                                                      </td>
                                                      <td className="px-1 py-0.5">
                                                        <input 
                                                          type="text" 
                                                          value={linha.observacao || ''} 
                                                          onChange={e => updateLinha(linha.id, 'observacao', e.target.value)}
                                                          placeholder="..."
                                                          className={`w-full px-1 py-0.5 border border-gray-200 rounded text-xs ${linha.is_excedente ? 'bg-red-50/50' : linha.is_reposicao ? 'bg-blue-50/50' : 'bg-white'}`}
                                                        />
                                                      </td>
                                                      <td className="px-1 py-0.5 text-center">
                                                        <button 
                                                          onClick={() => removeLinha(linha.id)} 
                                                          className="text-red-400 hover:text-red-600 text-xs"
                                                          title="Remover"
                                                        >
                                                          ×
                                                        </button>
                                                      </td>
                                                    </tr>
                                                  ));
                                                  })()}
                                                </tbody>
                                              </table>
                                            </div>
                                          )}
                                        </div>
                                      );
                                    })}
                                    
                                    {/* Botão Expandir/Recolher Todas */}
                                    <div className="flex gap-2 pt-2">
                                      <button 
                                        onClick={() => setFormData({...formData, dispLojasAbertas: lojasRegiao.map(l => l.id)})}
                                        className="px-3 py-1 text-xs bg-gray-100 text-gray-600 rounded hover:bg-gray-200"
                                      >
                                        📂 Expandir Todas
                                      </button>
                                      <button 
                                        onClick={() => setFormData({...formData, dispLojasAbertas: []})}
                                        className="px-3 py-1 text-xs bg-gray-100 text-gray-600 rounded hover:bg-gray-200"
                                      >
                                        📁 Recolher Todas
                                      </button>
                                    </div>
                                  </div>
                                );
                              })()}
                              
                              {/* Mensagem se nenhuma região selecionada */}
                              {!formData.dispRegiaoAtiva && (
                                <div className="bg-white rounded-xl shadow p-8 text-center">
                                  <p className="text-gray-500">👆 Selecione uma região acima para ver as lojas</p>
                                </div>
                              )}
                            </>
                          )}
                          
                          {/* Legenda */}
                          {(dispData.regioes || []).length > 0 && (
                            <div className="bg-white rounded-xl shadow p-3">
                              <h4 className="font-semibold text-gray-700 mb-2 text-sm">📊 Legenda</h4>
                              <div className="flex flex-wrap gap-2 text-xs">
                                <span className="px-2 py-1 bg-yellow-100 text-yellow-800 rounded font-semibold">A CONFIRMAR</span>
                                <span className="px-2 py-1 bg-green-100 text-green-800 rounded font-semibold">CONFIRMADO</span>
                                <span className="px-2 py-1 bg-blue-100 text-blue-800 rounded font-semibold">EM LOJA</span>
                                <span className="px-2 py-1 bg-red-100 text-red-800 rounded font-semibold">FALTANDO</span>
                                <span className="px-2 py-1 bg-red-50 text-red-700 rounded font-semibold border-l-4 border-red-400">EXCEDENTE</span>
                                <span className="px-2 py-1 bg-blue-50 text-blue-700 rounded font-semibold border-l-4 border-blue-400">REPOSIÇÃO</span>
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                      
                      {/* ===== SUB-ABA FALTOSOS ===== */}
                      {dispSubTab === 'faltosos' && (
                        <div className="space-y-4">
                          {/* Filtros */}
                          <div className="bg-white rounded-xl shadow p-4">
                            <h3 className="font-bold text-gray-800 mb-3">🔍 Filtros</h3>
                            <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                              <div>
                                <label className="text-xs text-gray-600">Data Início</label>
                                <input 
                                  type="date" 
                                  value={formData.faltososDataInicio || ''} 
                                  onChange={e => setFormData({...formData, faltososDataInicio: e.target.value})}
                                  className="w-full px-3 py-2 border rounded-lg text-sm"
                                />
                              </div>
                              <div>
                                <label className="text-xs text-gray-600">Data Fim</label>
                                <input 
                                  type="date" 
                                  value={formData.faltososDataFim || ''} 
                                  onChange={e => setFormData({...formData, faltososDataFim: e.target.value})}
                                  className="w-full px-3 py-2 border rounded-lg text-sm"
                                />
                              </div>
                              <div>
                                <label className="text-xs text-gray-600">Loja</label>
                                <select 
                                  value={formData.faltososLojaId || ''} 
                                  onChange={e => setFormData({...formData, faltososLojaId: e.target.value})}
                                  className="w-full px-3 py-2 border rounded-lg text-sm"
                                >
                                  <option value="">Todas as lojas</option>
                                  {(dispData.lojas || []).map(l => (
                                    <option key={l.id} value={l.id}>{l.codigo} - {l.nome}</option>
                                  ))}
                                </select>
                              </div>
                              <div className="flex items-end gap-2">
                                <button 
                                  onClick={async () => {
                                    try {
                                      let url = `${API_URL}/disponibilidade/faltosos?`;
                                      if (formData.faltososDataInicio) url += `data_inicio=${formData.faltososDataInicio}&`;
                                      if (formData.faltososDataFim) url += `data_fim=${formData.faltososDataFim}&`;
                                      if (formData.faltososLojaId) url += `loja_id=${formData.faltososLojaId}`;
                                      const res = await fetch(url);
                                      const data = await res.json();
                                      setFormData(f => ({...f, faltososLista: data}));
                                    } catch (err) {
                                      showToast('Erro ao buscar faltosos', 'error');
                                    }
                                  }}
                                  className="flex-1 px-4 py-2 bg-purple-600 text-white rounded-lg font-semibold hover:bg-purple-700"
                                >
                                  🔍 Buscar
                                </button>
                                <button 
                                  onClick={async () => {
                                    setFormData(f => ({...f, faltososDataInicio: '', faltososDataFim: '', faltososLojaId: ''}));
                                    try {
                                      const res = await fetch(`${API_URL}/disponibilidade/faltosos`);
                                      const data = await res.json();
                                      setFormData(f => ({...f, faltososLista: data}));
                                    } catch (err) {
                                      showToast('Erro ao buscar faltosos', 'error');
                                    }
                                  }}
                                  className="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg font-semibold hover:bg-gray-300"
                                >
                                  🔄 Limpar
                                </button>
                              </div>
                            </div>
                          </div>
                          
                          {/* Lista de Faltosos */}
                          <div className="bg-white rounded-xl shadow overflow-hidden">
                            <div className="px-4 py-3 bg-gray-50 border-b flex justify-between items-center">
                              <h3 className="font-bold text-gray-800">📋 Registro de Faltas ({(formData.faltososLista || []).length})</h3>
                            </div>
                            <div className="overflow-x-auto">
                              <table className="w-full text-xs">
                                <thead className="bg-gray-100">
                                  <tr>
                                    <th className="px-3 py-2 text-left">DATA</th>
                                    <th className="px-3 py-2 text-left">REGIÃO</th>
                                    <th className="px-3 py-2 text-left">LOJA</th>
                                    <th className="px-3 py-2 text-left">COD</th>
                                    <th className="px-3 py-2 text-left">PROFISSIONAL</th>
                                    <th className="px-3 py-2 text-left">MOTIVO</th>
                                    <th className="px-3 py-2 text-center w-16">AÇÃO</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {(formData.faltososLista || []).length === 0 ? (
                                    <tr>
                                      <td colSpan="7" className="px-3 py-8 text-center text-gray-500">
                                        Nenhum registro de falta encontrado.
                                      </td>
                                    </tr>
                                  ) : (
                                    (formData.faltososLista || []).map(f => (
                                      <tr key={f.id} className="border-t hover:bg-gray-50">
                                        <td className="px-3 py-2">{new Date(f.data_falta).toLocaleDateString('pt-BR')}</td>
                                        <td className="px-3 py-2">{f.regiao_nome}</td>
                                        <td className="px-3 py-2 font-mono">{f.loja_codigo} - {f.loja_nome}</td>
                                        <td className="px-3 py-2 font-mono">{f.cod_profissional || '-'}</td>
                                        <td className="px-3 py-2">{f.nome_profissional || '-'}</td>
                                        <td className="px-3 py-2 text-red-600">{f.motivo}</td>
                                        <td className="px-3 py-2 text-center">
                                          <button 
                                            onClick={async () => {
                                              if (!window.confirm(`Excluir registro de falta de ${f.nome_profissional || f.cod_profissional}?`)) return;
                                              try {
                                                await fetch(`${API_URL}/disponibilidade/faltosos/${f.id}`, { method: 'DELETE' });
                                                setFormData(prev => ({
                                                  ...prev, 
                                                  faltososLista: prev.faltososLista.filter(x => x.id !== f.id)
                                                }));
                                                showToast('✅ Falta excluída', 'success');
                                              } catch (err) {
                                                showToast('Erro ao excluir', 'error');
                                              }
                                            }}
                                            className="text-red-500 hover:text-red-700 hover:bg-red-50 px-2 py-1 rounded"
                                            title="Excluir falta"
                                          >
                                            🗑️
                                          </button>
                                        </td>
                                      </tr>
                                    ))
                                  )}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        </div>
                      )}
                      
                      {/* ===== SUB-ABA ESPELHO ===== */}
                      {dispSubTab === 'espelho' && (
                        <div className="space-y-4">
                          {/* Seletor de Data */}
                          <div className="bg-white rounded-xl shadow p-4">
                            <h3 className="font-bold text-gray-800 mb-3">🪞 Histórico de Planilhas</h3>
                            <div className="flex gap-3 items-end">
                              <div className="flex-1">
                                <label className="text-xs text-gray-600">Selecione a data</label>
                                <select 
                                  value={formData.espelhoDataSelecionada || ''} 
                                  onChange={async (e) => {
                                    const data = e.target.value;
                                    setFormData(f => ({...f, espelhoDataSelecionada: data, espelhoCarregando: true}));
                                    if (data) {
                                      try {
                                        const res = await fetch(`${API_URL}/disponibilidade/espelho/${data}`);
                                        const espelho = await res.json();
                                        console.log('Espelho carregado:', espelho);
                                        setFormData(f => ({...f, espelhoDados: espelho.dados, espelhoCarregando: false}));
                                      } catch (err) {
                                        console.error('Erro ao carregar espelho:', err);
                                        showToast('Erro ao carregar espelho', 'error');
                                        setFormData(f => ({...f, espelhoCarregando: false}));
                                      }
                                    } else {
                                      setFormData(f => ({...f, espelhoDados: null, espelhoCarregando: false}));
                                    }
                                  }}
                                  className="w-full px-3 py-2 border rounded-lg text-sm"
                                >
                                  <option value="">Selecione uma data...</option>
                                  {(formData.espelhoDatas || []).map(e => {
                                    // Formatar data corretamente (vem como "2024-12-02" ou "2024-12-02T00:00:00.000Z")
                                    const dataStr = e.data_registro?.split('T')[0] || e.data_registro;
                                    const [ano, mes, dia] = (dataStr || '').split('-');
                                    const dataFormatada = ano && mes && dia ? `${dia}/${mes}/${ano}` : dataStr;
                                    return (
                                      <option key={e.id} value={dataStr}>
                                        {dataFormatada}
                                      </option>
                                    );
                                  })}
                                </select>
                              </div>
                              <button 
                                onClick={async () => {
                                  try {
                                    const res = await fetch(`${API_URL}/disponibilidade/espelho`);
                                    const datas = await res.json();
                                    console.log('Datas espelho:', datas);
                                    setFormData(f => ({...f, espelhoDatas: datas}));
                                    showToast(`${datas.length} data(s) encontrada(s)!`, 'success');
                                  } catch (err) {
                                    showToast('Erro ao carregar datas', 'error');
                                  }
                                }}
                                className="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg font-semibold hover:bg-gray-200"
                              >
                                🔄 Atualizar
                              </button>
                              {/* Botão Excluir Espelho */}
                              {formData.espelhoDataSelecionada && (
                                <button 
                                  onClick={async () => {
                                    const espelhoSelecionado = (formData.espelhoDatas || []).find(e => {
                                      const dataStr = e.data_registro?.split('T')[0] || e.data_registro;
                                      return dataStr === formData.espelhoDataSelecionada;
                                    });
                                    if (!espelhoSelecionado) return;
                                    
                                    const dataFormatada = formData.espelhoDataSelecionada.split('-').reverse().join('/');
                                    if (!window.confirm(`⚠️ Excluir espelho de ${dataFormatada}?\n\nEssa ação não pode ser desfeita.`)) return;
                                    
                                    try {
                                      await fetch(`${API_URL}/disponibilidade/espelho/${espelhoSelecionado.id}`, { method: 'DELETE' });
                                      // Atualizar lista de datas
                                      const res = await fetch(`${API_URL}/disponibilidade/espelho`);
                                      const datas = await res.json();
                                      setFormData(f => ({
                                        ...f, 
                                        espelhoDatas: datas, 
                                        espelhoDataSelecionada: '', 
                                        espelhoDados: null
                                      }));
                                      showToast(`✅ Espelho de ${dataFormatada} excluído`, 'success');
                                    } catch (err) {
                                      showToast('Erro ao excluir espelho', 'error');
                                    }
                                  }}
                                  className="px-4 py-2 bg-red-100 text-red-700 rounded-lg font-semibold hover:bg-red-200"
                                >
                                  🗑️ Excluir
                                </button>
                              )}
                            </div>
                            {/* Info de datas disponíveis */}
                            <p className="text-xs text-gray-500 mt-2">
                              {(formData.espelhoDatas || []).length === 0 
                                ? 'Nenhum espelho salvo ainda. Use "Resetar Status" para criar o primeiro.' 
                                : `${(formData.espelhoDatas || []).length} espelho(s) disponível(is)`}
                            </p>
                          </div>
                          
                          {/* Visualização do Espelho */}
                          {formData.espelhoCarregando ? (
                            <div className="bg-white rounded-xl shadow p-8 text-center">
                              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-purple-600 mx-auto"></div>
                              <p className="mt-2 text-gray-500">Carregando...</p>
                            </div>
                          ) : formData.espelhoDados ? (
                            <div className="space-y-4">
                              {(() => {
                                const dados = typeof formData.espelhoDados === 'string' ? JSON.parse(formData.espelhoDados) : formData.espelhoDados;
                                console.log('Dados do espelho:', dados);
                                if (!dados || !dados.regioes || dados.regioes.length === 0) {
                                  return (
                                    <div className="bg-white rounded-xl shadow p-8 text-center">
                                      <p className="text-gray-500">Espelho vazio ou sem dados</p>
                                    </div>
                                  );
                                }
                                return (dados.regioes || []).map(regiao => {
                                  const lojasRegiao = (dados.lojas || []).filter(l => l.regiao_id === regiao.id);
                                  if (lojasRegiao.length === 0) return null;
                                  return (
                                    <div key={regiao.id} className="bg-white rounded-xl shadow overflow-hidden">
                                      <div className="bg-gradient-to-r from-purple-600 to-indigo-600 px-4 py-2">
                                        <h3 className="font-bold text-white text-sm">📍 {regiao.nome}</h3>
                                      </div>
                                      {lojasRegiao.map(loja => {
                                        const linhasLoja = (dados.linhas || []).filter(l => l.loja_id === loja.id);
                                        return (
                                          <div key={loja.id} className="border-t">
                                            <div className="px-3 py-2 bg-gray-50 font-semibold text-sm">
                                              {loja.codigo} - {loja.nome}
                                            </div>
                                            <table className="w-full text-xs">
                                              <tbody>
                                                {[...linhasLoja].sort((a, b) => {
                                                  if (a.is_reposicao && !b.is_reposicao) return -1;
                                                  if (!a.is_reposicao && b.is_reposicao) return 1;
                                                  if (a.is_excedente && !b.is_excedente) return 1;
                                                  if (!a.is_excedente && b.is_excedente) return -1;
                                                  return 0;
                                                }).map(linha => (
                                                  <tr key={linha.id} className={`border-t ${linha.is_excedente ? 'bg-red-50' : ''} ${linha.is_reposicao ? 'bg-blue-50' : ''}`}>
                                                    <td className={`w-1 ${linha.is_excedente ? 'bg-red-400' : ''} ${linha.is_reposicao ? 'bg-blue-400' : ''}`}></td>
                                                    <td className="px-2 py-1 font-mono w-20">{linha.cod_profissional || '-'}</td>
                                                    <td className="px-2 py-1">
                                                      <div className="flex items-center gap-1">
                                                        {linha.is_reposicao && <span className="text-[9px] text-blue-400 italic">reposição</span>}
                                                        {linha.is_excedente && <span className="text-[9px] text-red-400 italic">excedente</span>}
                                                        <span>{linha.nome_profissional || (!linha.is_reposicao && !linha.is_excedente ? '-' : '')}</span>
                                                      </div>
                                                    </td>
                                                    <td className="px-2 py-1 w-28">
                                                      <span className={`px-1 py-0.5 rounded text-xs ${
                                                        linha.status === 'EM LOJA' ? 'bg-blue-100 text-blue-800' :
                                                        linha.status === 'CONFIRMADO' ? 'bg-green-100 text-green-800' :
                                                        linha.status === 'FALTANDO' ? 'bg-red-100 text-red-800' :
                                                        'bg-yellow-100 text-yellow-800'
                                                      }`}>
                                                        {linha.status}
                                                      </span>
                                                    </td>
                                                    <td className="px-2 py-1 text-gray-500">{linha.observacao || ''}</td>
                                                  </tr>
                                                ))}
                                              </tbody>
                                            </table>
                                          </div>
                                        );
                                      })}
                                    </div>
                                  );
                                });
                              })()}
                            </div>
                          ) : (
                            <div className="bg-white rounded-xl shadow p-8 text-center">
                              <p className="text-gray-500">Selecione uma data para visualizar o histórico</p>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })()}
              </>
            )}

            {/* ESTATÍSTICAS */}
            {formData.adminTab === 'relatorios' && (() => {
              // Cálculos para o relatório
              const mesAtual = formData.relMes !== undefined ? parseInt(formData.relMes) : new Date().getMonth();
              const anoAtual = formData.relAno !== undefined ? parseInt(formData.relAno) : new Date().getFullYear();
              
              const submissoesMes = submissions.filter(s => {
                const d = new Date(s.created_at);
                return d.getMonth() === mesAtual && d.getFullYear() === anoAtual;
              });
              
              const aprovadas = submissoesMes.filter(s => s.status === 'aprovada');
              const rejeitadas = submissoesMes.filter(s => s.status === 'rejeitada');
              const pendentes = submissoesMes.filter(s => s.status === 'pendente');
              
              const taxaAprovacao = submissoesMes.length > 0 ? ((aprovadas.length / submissoesMes.length) * 100).toFixed(1) : 0;
              const taxaRejeicao = submissoesMes.length > 0 ? ((rejeitadas.length / submissoesMes.length) * 100).toFixed(1) : 0;
              
              // Por motivo
              const porMotivo = {};
              submissoesMes.forEach(s => {
                const motivo = s.motivo || 'Outros';
                if (!porMotivo[motivo]) porMotivo[motivo] = { total: 0, aprovadas: 0, rejeitadas: 0, pendentes: 0 };
                porMotivo[motivo].total++;
                if (s.status === 'aprovada') porMotivo[motivo].aprovadas++;
                if (s.status === 'rejeitada') porMotivo[motivo].rejeitadas++;
                if (s.status === 'pendente') porMotivo[motivo].pendentes++;
              });
              
              // Por profissional
              const porTecnico = {};
              submissoesMes.forEach(s => {
                const tec = s.user_name || s.cod_profissional || 'Desconhecido';
                if (!porTecnico[tec]) porTecnico[tec] = { total: 0, aprovadas: 0, rejeitadas: 0, cod: s.cod_profissional };
                porTecnico[tec].total++;
                if (s.status === 'aprovada') porTecnico[tec].aprovadas++;
                if (s.status === 'rejeitada') porTecnico[tec].rejeitadas++;
              });
              
              // Top 5 profissionais
              const topTecnicos = Object.entries(porTecnico)
                .map(([nome, dados]) => ({ nome, ...dados, taxa: dados.total > 0 ? ((dados.aprovadas / dados.total) * 100).toFixed(0) : 0 }))
                .sort((a, b) => b.total - a.total)
                .slice(0, 10);
              
              // Por semana
              const porSemana = [
                { label: 'Semana 1', dias: [1,7], total: 0, aprovadas: 0 },
                { label: 'Semana 2', dias: [8,14], total: 0, aprovadas: 0 },
                { label: 'Semana 3', dias: [15,21], total: 0, aprovadas: 0 },
                { label: 'Semana 4', dias: [22,31], total: 0, aprovadas: 0 }
              ];
              submissoesMes.forEach(s => {
                const dia = new Date(s.created_at).getDate();
                const semana = porSemana.find(sem => dia >= sem.dias[0] && dia <= sem.dias[1]);
                if (semana) {
                  semana.total++;
                  if (s.status === 'aprovada') semana.aprovadas++;
                }
              });
              const maxSemana = Math.max(...porSemana.map(s => s.total), 1);
              
              // Últimos 6 meses
              const ultimos6Meses = [];
              for (let i = 5; i >= 0; i--) {
                const d = new Date(anoAtual, mesAtual - i, 1);
                const mes = d.getMonth();
                const ano = d.getFullYear();
                const subs = submissions.filter(s => {
                  const sd = new Date(s.created_at);
                  return sd.getMonth() === mes && sd.getFullYear() === ano;
                });
                ultimos6Meses.push({
                  label: d.toLocaleDateString('pt-BR', { month: 'short' }),
                  total: subs.length,
                  aprovadas: subs.filter(s => s.status === 'aprovada').length
                });
              }
              const maxMes = Math.max(...ultimos6Meses.map(m => m.total), 1);
              
              // Mês anterior para comparativo
              const mesAnteriorData = new Date(anoAtual, mesAtual - 1, 1);
              const submissoesMesAnterior = submissions.filter(s => {
                const d = new Date(s.created_at);
                return d.getMonth() === mesAnteriorData.getMonth() && d.getFullYear() === mesAnteriorData.getFullYear();
              });
              const variacaoTotal = submissoesMesAnterior.length > 0 
                ? (((submissoesMes.length - submissoesMesAnterior.length) / submissoesMesAnterior.length) * 100).toFixed(1) 
                : 0;
              
              const meses = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
              
              // Função gerar PDF
              const gerarPDF = () => {
                const conteudo = `
                  <html>
                  <head>
                    <title>Relatório Tutts - ${meses[mesAtual]}/${anoAtual}</title>
                    <style>
                      body { font-family: Arial, sans-serif; padding: 20px; max-width: 800px; margin: 0 auto; }
                      h1 { color: #581c87; border-bottom: 2px solid #581c87; padding-bottom: 10px; }
                      h2 { color: #7c3aed; margin-top: 30px; }
                      .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
                      .cards { display: grid; grid-template-columns: repeat(4, 1fr); gap: 15px; margin: 20px 0; }
                      .card { background: #f3f4f6; padding: 15px; border-radius: 8px; text-align: center; }
                      .card-value { font-size: 28px; font-weight: bold; }
                      .green { color: #16a34a; }
                      .red { color: #dc2626; }
                      .yellow { color: #ca8a04; }
                      .purple { color: #7c3aed; }
                      table { width: 100%; border-collapse: collapse; margin: 15px 0; }
                      th, td { border: 1px solid #ddd; padding: 10px; text-align: left; }
                      th { background: #f3f4f6; }
                      .footer { margin-top: 40px; text-align: center; color: #666; font-size: 12px; border-top: 1px solid #ddd; padding-top: 20px; }
                      .comparativo { background: ${parseFloat(variacaoTotal) >= 0 ? '#dcfce7' : '#fee2e2'}; padding: 15px; border-radius: 8px; margin: 20px 0; }
                    </style>
                  </head>
                  <body>
                    <div class="header">
                      <h1>📊 Relatório Tutts</h1>
                      <div>
                        <strong>${meses[mesAtual]} / ${anoAtual}</strong><br>
                        <small>Gerado em: ${new Date().toLocaleString('pt-BR')}</small>
                      </div>
                    </div>
                    
                    <h2>📋 Resumo Geral</h2>
                    <div class="cards">
                      <div class="card"><div class="card-value purple">${submissoesMes.length}</div><div>Total</div></div>
                      <div class="card"><div class="card-value green">${aprovadas.length}</div><div>Aprovadas</div></div>
                      <div class="card"><div class="card-value red">${rejeitadas.length}</div><div>Rejeitadas</div></div>
                      <div class="card"><div class="card-value yellow">${pendentes.length}</div><div>Pendentes</div></div>
                    </div>
                    
                    <div class="cards">
                      <div class="card"><div class="card-value green">${taxaAprovacao}%</div><div>Taxa Aprovação</div></div>
                      <div class="card"><div class="card-value red">${taxaRejeicao}%</div><div>Taxa Rejeição</div></div>
                      <div class="card"><div class="card-value purple">${users.length}</div><div>Profissionais</div></div>
                      <div class="card"><div class="card-value purple">${users.length > 0 ? (submissoesMes.length / users.length).toFixed(1) : 0}</div><div>Média/Profissional</div></div>
                    </div>
                    
                    <div class="comparativo">
                      <strong>📊 Comparativo com Mês Anterior:</strong> 
                      ${parseFloat(variacaoTotal) >= 0 ? '📈' : '📉'} ${parseFloat(variacaoTotal) >= 0 ? '+' : ''}${variacaoTotal}% 
                      (${submissoesMesAnterior.length} → ${submissoesMes.length} solicitações)
                    </div>
                    
                    <h2>📁 Por Motivo</h2>
                    <table>
                      <thead><tr><th>Motivo</th><th>Total</th><th>Aprovadas</th><th>Rejeitadas</th><th>Pendentes</th><th>Taxa</th></tr></thead>
                      <tbody>
                        ${Object.entries(porMotivo).map(([motivo, dados]) => `
                          <tr>
                            <td>${motivo}</td>
                            <td>${dados.total}</td>
                            <td class="green">${dados.aprovadas}</td>
                            <td class="red">${dados.rejeitadas}</td>
                            <td class="yellow">${dados.pendentes}</td>
                            <td>${dados.total > 0 ? ((dados.aprovadas / dados.total) * 100).toFixed(0) : 0}%</td>
                          </tr>
                        `).join('')}
                      </tbody>
                    </table>
                    
                    <h2>👷 Top 10 Profissionais</h2>
                    <table>
                      <thead><tr><th>#</th><th>Profissional</th><th>Código</th><th>Total</th><th>Aprovadas</th><th>Rejeitadas</th><th>Taxa</th></tr></thead>
                      <tbody>
                        ${topTecnicos.map((t, i) => `
                          <tr>
                            <td>${i + 1}</td>
                            <td>${t.nome}</td>
                            <td>${t.cod || '-'}</td>
                            <td>${t.total}</td>
                            <td class="green">${t.aprovadas}</td>
                            <td class="red">${t.rejeitadas}</td>
                            <td>${t.taxa}%</td>
                          </tr>
                        `).join('')}
                      </tbody>
                    </table>
                    
                    <h2>📅 Por Semana</h2>
                    <table>
                      <thead><tr><th>Semana</th><th>Total</th><th>Aprovadas</th><th>Taxa</th></tr></thead>
                      <tbody>
                        ${porSemana.map(s => `
                          <tr>
                            <td>${s.label} (dias ${s.dias[0]}-${s.dias[1]})</td>
                            <td>${s.total}</td>
                            <td class="green">${s.aprovadas}</td>
                            <td>${s.total > 0 ? ((s.aprovadas / s.total) * 100).toFixed(0) : 0}%</td>
                          </tr>
                        `).join('')}
                      </tbody>
                    </table>
                    
                    <div class="footer">
                      <strong>Sistema Tutts</strong> - Relatório Gerado Automaticamente<br>
                      ${new Date().toLocaleString('pt-BR')}
                    </div>
                  </body>
                  </html>
                `;
                const janela = window.open('', '_blank');
                janela.document.write(conteudo);
                janela.document.close();
                janela.print();
              };
              
              return (
                <>
                  {/* Seletor de Período */}
                  <div className="bg-white rounded-xl shadow p-4 mb-6 flex flex-wrap items-center gap-4">
                    <div className="flex items-center gap-2">
                      <label className="font-semibold">📅 Período:</label>
                      <select value={mesAtual} onChange={e => setFormData({...formData, relMes: e.target.value})} className="px-3 py-2 border rounded-lg">
                        {meses.map((m, i) => <option key={i} value={i}>{m}</option>)}
                      </select>
                      <select value={anoAtual} onChange={e => setFormData({...formData, relAno: e.target.value})} className="px-3 py-2 border rounded-lg">
                        {[2024, 2025, 2026].map(a => <option key={a} value={a}>{a}</option>)}
                      </select>
                    </div>
                    <button onClick={gerarPDF} className="ml-auto px-4 py-2 bg-red-600 text-white rounded-lg font-semibold hover:bg-red-700 flex items-center gap-2">
                      📄 Gerar PDF
                    </button>
                  </div>
                  
                  {/* Cards Principais */}
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
                    <div className="bg-white rounded-xl shadow p-4 border-l-4 border-purple-500">
                      <p className="text-xs text-gray-500">📋 Total Solicitações</p>
                      <p className="text-3xl font-bold text-purple-600">{submissoesMes.length}</p>
                    </div>
                    <div className="bg-white rounded-xl shadow p-4 border-l-4 border-green-500">
                      <p className="text-xs text-gray-500">✅ Aprovadas</p>
                      <p className="text-3xl font-bold text-green-600">{aprovadas.length}</p>
                    </div>
                    <div className="bg-white rounded-xl shadow p-4 border-l-4 border-red-500">
                      <p className="text-xs text-gray-500">❌ Rejeitadas</p>
                      <p className="text-3xl font-bold text-red-600">{rejeitadas.length}</p>
                    </div>
                    <div className="bg-white rounded-xl shadow p-4 border-l-4 border-yellow-500">
                      <p className="text-xs text-gray-500">⏳ Pendentes</p>
                      <p className="text-3xl font-bold text-yellow-600">{pendentes.length}</p>
                    </div>
                  </div>
                  
                  {/* Cards de Taxas */}
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
                    <div className="bg-green-50 rounded-xl p-4 text-center border border-green-200">
                      <p className="text-3xl font-bold text-green-600">{taxaAprovacao}%</p>
                      <p className="text-xs text-green-700">Taxa de Aprovação</p>
                    </div>
                    <div className="bg-red-50 rounded-xl p-4 text-center border border-red-200">
                      <p className="text-3xl font-bold text-red-600">{taxaRejeicao}%</p>
                      <p className="text-xs text-red-700">Taxa de Rejeição</p>
                    </div>
                    <div className="bg-purple-50 rounded-xl p-4 text-center border border-purple-200">
                      <p className="text-3xl font-bold text-purple-600">{users.length}</p>
                      <p className="text-xs text-purple-700">Total Profissionais</p>
                    </div>
                    <div className="bg-blue-50 rounded-xl p-4 text-center border border-blue-200">
                      <p className="text-3xl font-bold text-blue-600">{users.length > 0 ? (submissoesMes.length / users.length).toFixed(1) : 0}</p>
                      <p className="text-xs text-blue-700">Média por Profissional</p>
                    </div>
                  </div>
                  
                  {/* Comparativo */}
                  <div className={`rounded-xl p-4 mb-6 ${parseFloat(variacaoTotal) >= 0 ? 'bg-green-50 border border-green-200' : 'bg-red-50 border border-red-200'}`}>
                    <h3 className="font-semibold mb-2">📊 Comparativo com Mês Anterior</h3>
                    <div className="flex items-center gap-6">
                      <div>
                        <p className="text-sm text-gray-600">Mês anterior: <strong>{submissoesMesAnterior.length}</strong> solicitações</p>
                        <p className="text-sm text-gray-600">Mês atual: <strong>{submissoesMes.length}</strong> solicitações</p>
                      </div>
                      <div className={`text-3xl font-bold ${parseFloat(variacaoTotal) >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                        {parseFloat(variacaoTotal) >= 0 ? '📈' : '📉'} {parseFloat(variacaoTotal) >= 0 ? '+' : ''}{variacaoTotal}%
                      </div>
                    </div>
                  </div>
                  
                  {/* Gráficos */}
                  <div className="grid md:grid-cols-2 gap-6 mb-6">
                    {/* Evolução 6 meses */}
                    <div className="bg-white rounded-xl shadow p-6">
                      <h3 className="font-semibold mb-4">📈 Evolução (Últimos 6 meses)</h3>
                      <div className="flex items-end justify-between h-40 gap-2">
                        {ultimos6Meses.map((m, i) => (
                          <div key={i} className="flex-1 flex flex-col items-center">
                            <div className="w-full bg-gray-100 rounded-t relative" style={{height: `${(m.total / maxMes) * 100}%`, minHeight: '20px'}}>
                              <div className="absolute inset-0 bg-gradient-to-t from-purple-600 to-purple-400 rounded-t"></div>
                            </div>
                            <p className="text-xs font-bold mt-1">{m.total}</p>
                            <p className="text-xs text-gray-500">{m.label}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                    
                    {/* Por Semana */}
                    <div className="bg-white rounded-xl shadow p-6">
                      <h3 className="font-semibold mb-4">📅 Por Semana ({meses[mesAtual]})</h3>
                      <div className="flex items-end justify-between h-40 gap-2">
                        {porSemana.map((s, i) => (
                          <div key={i} className="flex-1 flex flex-col items-center">
                            <div className="w-full bg-gray-100 rounded-t relative" style={{height: `${(s.total / maxSemana) * 100}%`, minHeight: '20px'}}>
                              <div className="absolute inset-0 bg-gradient-to-t from-blue-600 to-blue-400 rounded-t"></div>
                            </div>
                            <p className="text-xs font-bold mt-1">{s.total}</p>
                            <p className="text-xs text-gray-500">Sem {i+1}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                  
                  {/* Por Motivo */}
                  <div className="bg-white rounded-xl shadow p-6 mb-6">
                    <h3 className="font-semibold mb-4">📁 Por Motivo</h3>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-gray-50">
                          <tr>
                            <th className="px-4 py-3 text-left">Motivo</th>
                            <th className="px-4 py-3 text-center">Total</th>
                            <th className="px-4 py-3 text-center">✅ Aprovadas</th>
                            <th className="px-4 py-3 text-center">❌ Rejeitadas</th>
                            <th className="px-4 py-3 text-center">⏳ Pendentes</th>
                            <th className="px-4 py-3 text-center">Taxa</th>
                          </tr>
                        </thead>
                        <tbody>
                          {Object.entries(porMotivo).sort((a,b) => b[1].total - a[1].total).map(([motivo, dados]) => (
                            <tr key={motivo} className="border-t hover:bg-gray-50">
                              <td className="px-4 py-3 font-semibold">{motivo}</td>
                              <td className="px-4 py-3 text-center font-bold">{dados.total}</td>
                              <td className="px-4 py-3 text-center text-green-600 font-semibold">{dados.aprovadas}</td>
                              <td className="px-4 py-3 text-center text-red-600 font-semibold">{dados.rejeitadas}</td>
                              <td className="px-4 py-3 text-center text-yellow-600 font-semibold">{dados.pendentes}</td>
                              <td className="px-4 py-3 text-center">
                                <span className={`px-2 py-1 rounded text-xs font-bold ${dados.total > 0 && (dados.aprovadas / dados.total) >= 0.7 ? 'bg-green-100 text-green-700' : dados.total > 0 && (dados.aprovadas / dados.total) >= 0.4 ? 'bg-yellow-100 text-yellow-700' : 'bg-red-100 text-red-700'}`}>
                                  {dados.total > 0 ? ((dados.aprovadas / dados.total) * 100).toFixed(0) : 0}%
                                </span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                  
                  {/* Top 10 Profissionais */}
                  <div className="bg-white rounded-xl shadow p-6">
                    <h3 className="font-semibold mb-4">👷 Top 10 Profissionais do Mês</h3>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-gray-50">
                          <tr>
                            <th className="px-4 py-3 text-center">#</th>
                            <th className="px-4 py-3 text-left">Profissional</th>
                            <th className="px-4 py-3 text-left">Código</th>
                            <th className="px-4 py-3 text-center">Total</th>
                            <th className="px-4 py-3 text-center">✅</th>
                            <th className="px-4 py-3 text-center">❌</th>
                            <th className="px-4 py-3 text-center">Taxa</th>
                          </tr>
                        </thead>
                        <tbody>
                          {topTecnicos.map((t, i) => (
                            <tr key={i} className={`border-t hover:bg-gray-50 ${i < 3 ? 'bg-yellow-50' : ''}`}>
                              <td className="px-4 py-3 text-center">
                                {i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : i + 1}
                              </td>
                              <td className="px-4 py-3 font-semibold">{t.nome}</td>
                              <td className="px-4 py-3 font-mono text-gray-600">{t.cod || '-'}</td>
                              <td className="px-4 py-3 text-center font-bold">{t.total}</td>
                              <td className="px-4 py-3 text-center text-green-600 font-semibold">{t.aprovadas}</td>
                              <td className="px-4 py-3 text-center text-red-600 font-semibold">{t.rejeitadas}</td>
                              <td className="px-4 py-3 text-center">
                                <span className={`px-2 py-1 rounded text-xs font-bold ${parseInt(t.taxa) >= 70 ? 'bg-green-100 text-green-700' : parseInt(t.taxa) >= 40 ? 'bg-yellow-100 text-yellow-700' : 'bg-red-100 text-red-700'}`}>
                                  {t.taxa}%
                                </span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </>
              );
            })()}

            {/* USUÁRIOS */}
            {formData.adminTab === 'users' && (
              <div className="bg-white rounded-xl shadow p-6">
                <h2 className="text-lg font-semibold mb-4">👥 Gerenciar Usuários</h2>
                <div className="bg-purple-50 border border-purple-200 rounded-lg p-4 mb-6">
                  <h3 className="font-semibold mb-3">➕ Criar Usuário</h3>
                  <div className="space-y-4">
                    <div className="grid md:grid-cols-2 gap-4">
                      <div><label className="block text-sm font-semibold mb-1">Nome</label><input type="text" value={formData.newName || ''} onChange={e => setFormData({...formData, newName: e.target.value})} className="w-full px-3 py-2 border rounded" /></div>
                      <div><label className="block text-sm font-semibold mb-1">Código</label><input type="text" value={formData.newCod || ''} onChange={e => setFormData({...formData, newCod: e.target.value})} className="w-full px-3 py-2 border rounded" /></div>
                    </div>
                    <div className="grid md:grid-cols-2 gap-4">
                      <div><label className="block text-sm font-semibold mb-1">Senha</label><input type="password" value={formData.newPass || ''} onChange={e => setFormData({...formData, newPass: e.target.value})} className="w-full px-3 py-2 border rounded" /></div>
                      <div><label className="block text-sm font-semibold mb-1">Tipo</label><select value={formData.newRole || 'user'} onChange={e => setFormData({...formData, newRole: e.target.value})} className="w-full px-3 py-2 border rounded bg-white"><option value="user">👤 Usuário</option><option value="admin">👑 Admin</option><option value="admin_financeiro">💰 Admin Financeiro</option></select></div>
                    </div>
                    <button onClick={async () => {
                      if (!formData.newName || !formData.newCod || !formData.newPass) { showToast('Preencha todos', 'error'); return; }
                      setLoading(true);
                      try {
                        await fetch(`${API_URL}/users/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fullName: formData.newName, codProfissional: formData.newCod, password: formData.newPass, role: formData.newRole || 'user' }) });
                        showToast('✅ Criado!', 'success');
                        setFormData({...formData, newName: '', newCod: '', newPass: '', newRole: 'user'});
                        loadUsers();
                      } catch { showToast('Erro', 'error'); }
                      setLoading(false);
                    }} className="w-full px-6 py-2 bg-purple-600 text-white rounded font-semibold">➕ Criar Usuário</button>
                  </div>
                </div>
                <h3 className="font-semibold mb-3">📋 Usuários Cadastrados ({users.length})</h3>
                <div className="space-y-2">
                  {users.map(u => (
                    <div key={u.codProfissional} className="border rounded-lg p-4 flex items-center justify-between hover:bg-gray-50">
                      <div className="flex-1"><p className="font-semibold">{u.fullName}</p><p className="text-sm text-gray-600">COD: {u.codProfissional} • {u.role}</p><p className="text-xs text-gray-400">{u.createdAt}</p></div>
                      <div className="flex gap-2 items-center">
                        <input type="password" placeholder="Nova senha" value={formData[`newpass_${u.codProfissional}`] || ''} onChange={e => setFormData({...formData, [`newpass_${u.codProfissional}`]: e.target.value})} className="px-3 py-2 border rounded text-sm w-32" />
                        <button onClick={async () => {
                          const pw = formData[`newpass_${u.codProfissional}`];
                          if (!pw || pw.length < 4) { showToast('Senha muito curta', 'error'); return; }
                          await fetch(`${API_URL}/users/reset-password`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ codProfissional: u.codProfissional, newPassword: pw }) });
                          showToast('✅ Senha alterada!', 'success');
                          setFormData({...formData, [`newpass_${u.codProfissional}`]: ''});
                        }} className="px-4 py-2 bg-purple-600 text-white rounded text-sm font-semibold">🔑 Resetar</button>
                        <button onClick={async () => {
                          const confirmMsg = `⚠️ ATENÇÃO!\n\nExcluir ${u.fullName} (${u.codProfissional})?\n\nTODOS os dados associados serão excluídos:\n• Solicitações de saque\n• Histórico de saques\n• Gratuidades\n• Indicações\n• Inscrições em promoções\n• Respostas do quiz\n\nEsta ação NÃO pode ser desfeita!`;
                          if (!confirm(confirmMsg)) return;
                          try {
                            const res = await fetch(`${API_URL}/users/${u.codProfissional}`, { method: 'DELETE' });
                            const data = await res.json();
                            if (res.ok) {
                              const deleted = data.deleted;
                              showToast(`🗑️ Excluído! (${deleted.submissions} solicitações, ${deleted.withdrawals} saques, ${deleted.gratuities} gratuidades, ${deleted.indicacoes} indicações)`, 'success');
                            } else {
                              throw new Error(data.error);
                            }
                          } catch (err) {
                            showToast('❌ Erro ao excluir: ' + err.message, 'error');
                          }
                          loadUsers();
                        }} className="px-4 py-2 bg-red-600 text-white rounded text-sm font-semibold">🗑️</button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      );
    };

    ReactDOM.render(<App />, document.getElementById('root'));
  </script>
  
  <!-- PWA Install Banner Component -->
  <div id="pwa-install-banner" style="display: none;" class="fixed bottom-4 left-4 right-4 bg-gradient-to-r from-purple-600 to-purple-700 text-white rounded-2xl shadow-2xl p-4 z-50 pwa-install-banner">
    <div class="flex items-center gap-4">
      <div class="w-14 h-14 bg-white rounded-xl flex items-center justify-center text-3xl shadow">
        🚀
      </div>
      <div class="flex-1">
        <h3 class="font-bold text-lg">Instalar Tutts</h3>
        <p class="text-purple-200 text-sm">Acesse mais rápido pela tela inicial!</p>
      </div>
      <div class="flex flex-col gap-2">
        <button id="pwa-install-btn" class="px-4 py-2 bg-white text-purple-700 rounded-lg font-bold text-sm hover:bg-purple-100 transition-all">
          Instalar
        </button>
        <button id="pwa-dismiss-btn" class="text-purple-300 text-xs hover:text-white">
          Agora não
        </button>
      </div>
    </div>
  </div>

  <!-- PWA Service Worker Registration -->
  <script>
    // Registrar Service Worker
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js')
          .then(reg => console.log('✅ Service Worker registrado:', reg.scope))
          .catch(err => console.log('❌ Service Worker erro:', err));
      });
    }

    // PWA Install Prompt
    let deferredPrompt;
    const installBanner = document.getElementById('pwa-install-banner');
    const installBtn = document.getElementById('pwa-install-btn');
    const dismissBtn = document.getElementById('pwa-dismiss-btn');

    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredPrompt = e;
      
      // Verificar se já foi dispensado recentemente
      const dismissed = localStorage.getItem('pwa-dismissed');
      if (dismissed && (Date.now() - parseInt(dismissed)) < 7 * 24 * 60 * 60 * 1000) {
        return; // Não mostrar se dispensou nos últimos 7 dias
      }
      
      // Mostrar banner após 3 segundos
      setTimeout(() => {
        installBanner.style.display = 'block';
      }, 3000);
    });

    installBtn?.addEventListener('click', async () => {
      if (!deferredPrompt) return;
      
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      
      if (outcome === 'accepted') {
        console.log('✅ PWA instalado!');
      }
      
      deferredPrompt = null;
      installBanner.style.display = 'none';
    });

    dismissBtn?.addEventListener('click', () => {
      installBanner.style.display = 'none';
      localStorage.setItem('pwa-dismissed', Date.now().toString());
    });

    // Detectar se já está instalado
    window.addEventListener('appinstalled', () => {
      installBanner.style.display = 'none';
      console.log('✅ PWA instalado com sucesso!');
    });
  </script>
</body>
</html>
