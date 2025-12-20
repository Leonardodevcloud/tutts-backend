const {
    useState: useState,
    useEffect: useEffect
} = React, API_URL = "https://tutts-backend-production.up.railway.app/api";
fetch(`${API_URL.replace("/api","")}/health`).catch(() => {});
const hideLoadingScreen = () => {
        const e = document.getElementById("loading-screen");
        e && (e.classList.add("fade-out"), setTimeout(() => e.remove(), 500))
    },
    Toast = ({
        message: e,
        type: t
    }) => React.createElement("div", {
        className: `fixed top-4 right-4 z-50 px-6 py-4 rounded-lg shadow-2xl toast ${"success"===t?"bg-green-600":"bg-red-600"} text-white font-semibold flex items-center gap-3`
    }, React.createElement("span", {
        className: "text-2xl"
    }, "success" === t ? "✓" : "✗"), React.createElement("span", null, e)),
    LoadingOverlay = ({
        message: e = "Carregando..."
    }) => React.createElement("div", {
        className: "fixed inset-0 bg-black bg-opacity-30 z-50 flex items-center justify-center"
    }, React.createElement("div", {
        className: "bg-white rounded-xl p-6 shadow-2xl flex flex-col items-center gap-3"
    }, React.createElement("div", {
        className: "w-10 h-10 border-4 border-purple-600 border-t-transparent rounded-full animate-spin"
    }), React.createElement("p", {
        className: "text-gray-700 font-semibold"
    }, e))),
    ImageModal = ({
        imageUrl: e,
        onClose: t
    }) => React.createElement("div", {
        className: "fixed inset-0 bg-black bg-opacity-75 z-50 flex items-center justify-center p-4",
        onClick: t
    }, React.createElement("div", {
        className: "relative max-w-4xl max-h-screen"
    }, React.createElement("button", {
        onClick: t,
        className: "absolute -top-10 right-0 text-white text-3xl hover:text-gray-300"
    }, "✕"), React.createElement("img", {
        src: e,
        alt: "Expandido",
        className: "max-w-full max-h-screen rounded-lg shadow-2xl",
        onClick: e => e.stopPropagation()
    }))),
    calcularCRC16 = e => {
        let t = 65535;
        for (let a = 0; a < e.length; a++) {
            t ^= e.charCodeAt(a) << 8;
            for (let e = 0; e < 8; e++) t = 32768 & t ? 65535 & (t << 1 ^ 4129) : t << 1 & 65535
        }
        return t.toString(16).toUpperCase().padStart(4, "0")
    },
    montarCampo = (e, t) => `${e}${t.length.toString().padStart(2,"0")}${t}`,
    formatarChavePix = e => {
        let t = e.trim();
        if (t.includes("@")) return t.toLowerCase().trim();
        if (/[a-zA-Z]/.test(t)) return t;
        const a = t.replace(/\D/g, "");
        return t.includes("(") || t.includes(")") ? "+55" + a : 14 === a.length ? a : 13 === a.length && a.startsWith("55") ? "+" + a : 10 === a.length ? "+55" + a : 11 === a.length ? t.includes(".") && t.includes("-") ? a : "9" === a.charAt(2) ? "+55" + a : a : t.startsWith("+") ? "+" + a : a || t
    },
    generatePixCode = (e, t, a, l = "BRASILIA") => {
        const r = formatarChavePix(e),
            o = a.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9 ]/g, "").toUpperCase().substring(0, 25).trim(),
            c = l.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9 ]/g, "").toUpperCase().substring(0, 15).trim(),
            s = parseFloat(t).toFixed(2),
            n = montarCampo("00", "br.gov.bcb.pix") + montarCampo("01", r),
            m = montarCampo("05", "***");
        let i = "";
        i += montarCampo("00", "01"), i += montarCampo("26", n), i += montarCampo("52", "0000"), i += montarCampo("53", "986"), i += montarCampo("54", s), i += montarCampo("58", "BR"), i += montarCampo("59", o), i += montarCampo("60", c), i += montarCampo("62", m), i += "6304";
        return i += calcularCRC16(i), i
    },
    PixQRCodeModal = ({
        withdrawal: e,
        onClose: t,
        showToast: a
    }) => {
        const [l, r] = React.useState(""), [o, c] = React.useState(""), [s, n] = React.useState(!1), [m, i] = React.useState(!0), [d, p] = React.useState("");
        React.useRef(null);
        React.useEffect(() => {
            if (e) try {
                const t = generatePixCode(e.pix_key, e.final_amount, e.user_name);
                if (c(t), "undefined" != typeof QRCode && QRCode.toDataURL) QRCode.toDataURL(t, {
                    errorCorrectionLevel: "M",
                    type: "image/png",
                    width: 300,
                    margin: 2,
                    color: {
                        dark: "#000000",
                        light: "#FFFFFF"
                    }
                }).then(e => {
                    r(e), i(!1)
                }).catch(e => {
                    console.error("Erro QRCode.toDataURL:", e);
                    const a = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(t)}`;
                    r(a), i(!1)
                });
                else {
                    const e = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(t)}`;
                    r(e), i(!1)
                }
            } catch (e) {
                console.error("Erro ao gerar PIX:", e), p("Erro ao gerar código PIX"), i(!1)
            }
        }, [e]);
        return e ? React.createElement("div", {
            className: "fixed inset-0 bg-black bg-opacity-60 z-50 flex items-center justify-center p-4",
            onClick: t
        }, React.createElement("div", {
            className: "bg-white rounded-2xl shadow-2xl max-w-md w-full overflow-hidden",
            onClick: e => e.stopPropagation()
        }, React.createElement("div", {
            className: "bg-gradient-to-r from-green-600 to-green-700 text-white p-4"
        }, React.createElement("div", {
            className: "flex items-center justify-between"
        }, React.createElement("div", {
            className: "flex items-center gap-3"
        }, React.createElement("span", {
            className: "text-3xl"
        }, "💰"), React.createElement("div", null, React.createElement("h2", {
            className: "text-lg font-bold"
        }, "PIX Copia e Cola"), React.createElement("p", {
            className: "text-green-200 text-sm"
        }, "Escaneie ou copie o código"))), React.createElement("button", {
            onClick: t,
            className: "text-white/80 hover:text-white text-2xl font-bold"
        }, "✕"))), React.createElement("div", {
            className: "p-6"
        }, React.createElement("div", {
            className: "bg-gray-50 rounded-xl p-4 mb-4"
        }, React.createElement("div", {
            className: "grid grid-cols-2 gap-3 text-sm"
        }, React.createElement("div", null, React.createElement("p", {
            className: "text-gray-500 text-xs"
        }, "Beneficiário"), React.createElement("p", {
            className: "font-semibold text-gray-800 truncate"
        }, e.user_name)), React.createElement("div", null, React.createElement("p", {
            className: "text-gray-500 text-xs"
        }, "Código"), React.createElement("p", {
            className: "font-semibold text-gray-800"
        }, e.user_cod)), React.createElement("div", {
            className: "col-span-2"
        }, React.createElement("p", {
            className: "text-gray-500 text-xs"
        }, "Chave PIX (original)"), React.createElement("p", {
            className: "font-semibold text-gray-800 text-sm break-all"
        }, e.pix_key)), React.createElement("div", {
            className: "col-span-2"
        }, React.createElement("p", {
            className: "text-gray-500 text-xs"
        }, "Chave PIX (formatada para envio)"), React.createElement("p", {
            className: "font-semibold text-blue-600 text-sm break-all font-mono"
        }, formatarChavePix(e.pix_key))), React.createElement("div", {
            className: "col-span-2"
        }, React.createElement("p", {
            className: "text-gray-500 text-xs"
        }, "Valor a Transferir"), React.createElement("p", {
            className: "font-bold text-green-600 text-2xl"
        }, "R$ ", parseFloat(e.final_amount).toFixed(2).replace(".", ","))))), React.createElement("div", {
            className: "flex flex-col items-center mb-4"
        }, m ? React.createElement("div", {
            className: "w-64 h-64 bg-gray-100 rounded-xl flex items-center justify-center"
        }, React.createElement("div", {
            className: "text-center"
        }, React.createElement("div", {
            className: "w-10 h-10 border-4 border-green-600 border-t-transparent rounded-full animate-spin mx-auto mb-2"
        }), React.createElement("p", {
            className: "text-gray-500 text-sm"
        }, "Gerando QR Code..."))) : d ? React.createElement("div", {
            className: "w-64 h-64 bg-red-50 rounded-xl flex items-center justify-center"
        }, React.createElement("p", {
            className: "text-red-500 text-center p-4"
        }, d)) : l ? React.createElement("img", {
            src: l,
            alt: "QR Code PIX",
            className: "w-64 h-64 border-4 border-green-200 rounded-xl shadow-lg",
            onError: () => {
                const e = `https://chart.googleapis.com/chart?cht=qr&chs=300x300&chl=${encodeURIComponent(o)}`;
                r(e)
            }
        }) : null), React.createElement("div", {
            className: "mb-4"
        }, React.createElement("p", {
            className: "text-xs text-gray-500 mb-2 font-semibold"
        }, "Código Copia e Cola:"), React.createElement("div", {
            className: "bg-gray-100 rounded-lg p-3 text-[10px] font-mono text-gray-600 break-all max-h-24 overflow-y-auto border"
        }, o)), React.createElement("button", {
            onClick: async () => {
                try {
                    await navigator.clipboard.writeText(o), n(!0), a("✅ Código PIX copiado!", "success"), setTimeout(() => n(!1), 3e3)
                } catch (e) {
                    const t = document.createElement("textarea");
                    t.value = o, t.style.position = "fixed", t.style.left = "-9999px", document.body.appendChild(t), t.select();
                    try {
                        document.execCommand("copy"), n(!0), a("✅ Código PIX copiado!", "success"), setTimeout(() => n(!1), 3e3)
                    } catch (e) {
                        a("❌ Erro ao copiar", "error")
                    }
                    document.body.removeChild(t)
                }
            },
            className: "w-full py-4 rounded-xl font-bold text-white transition-all flex items-center justify-center gap-2 text-lg " + (s ? "bg-green-500" : "bg-green-600 hover:bg-green-700 active:scale-95")
        }, s ? React.createElement(React.Fragment, null, "✅ Código Copiado!") : React.createElement(React.Fragment, null, "📋 Copiar Código PIX")), React.createElement("p", {
            className: "text-xs text-gray-400 text-center mt-3"
        }, "⚠️ Confira os dados antes de efetuar o pagamento")))) : null
    },
    PieChart = ({
        data: e,
        title: t
    }) => {
        const a = e.reduce((e, t) => e + t.value, 0);
        if (0 === a) return React.createElement("div", {
            className: "bg-white rounded-xl shadow p-6"
        }, React.createElement("h3", {
            className: "text-lg font-semibold mb-4"
        }, t), React.createElement("p", {
            className: "text-gray-500 text-center py-8"
        }, "Sem dados disponíveis"));
        let l = 0;
        const r = e.map((e, t) => {
            const r = e.value / a * 100,
                o = r / 100 * 360,
                c = l;
            l += o;
            const s = 100 + 90 * Math.cos((c - 90) * Math.PI / 180),
                n = 100 + 90 * Math.sin((c - 90) * Math.PI / 180),
                m = 100 + 90 * Math.cos((l - 90) * Math.PI / 180),
                i = 100 + 90 * Math.sin((l - 90) * Math.PI / 180),
                d = o > 180 ? 1 : 0;
            return {
                ...e,
                path: `M 100 100 L ${s} ${n} A 90 90 0 ${d} 1 ${m} ${i} Z`,
                percentage: r.toFixed(1)
            }
        });
        return React.createElement("div", {
            className: "bg-white rounded-xl shadow p-6"
        }, React.createElement("h3", {
            className: "text-lg font-semibold mb-4"
        }, t), React.createElement("div", {
            className: "flex flex-col md:flex-row items-center gap-6"
        }, React.createElement("svg", {
            viewBox: "0 0 200 200",
            className: "w-48 h-48"
        }, r.map((e, t) => React.createElement("path", {
            key: t,
            d: e.path,
            fill: e.color,
            className: "hover:opacity-80 transition-opacity cursor-pointer"
        }))), React.createElement("div", {
            className: "flex-1 space-y-2"
        }, r.map((e, t) => React.createElement("div", {
            key: t,
            className: "flex items-center gap-2"
        }, React.createElement("div", {
            className: "w-4 h-4 rounded",
            style: {
                backgroundColor: e.color
            }
        }), React.createElement("span", {
            className: "text-sm flex-1"
        }, e.label), React.createElement("span", {
            className: "font-semibold"
        }, e.value), React.createElement("span", {
            className: "text-gray-500 text-sm"
        }, "(", e.percentage, "%)"))))))
    },
    StatusPieChart = ({
        submissions: e
    }) => {
        const t = {
                pendente: e.filter(e => "pendente" === e.status).length,
                aprovada: e.filter(e => "aprovada" === e.status).length,
                rejeitada: e.filter(e => "rejeitada" === e.status).length
            },
            a = e.length,
            l = [{
                label: "Pendentes",
                value: t.pendente,
                color: "#eab308"
            }, {
                label: "Aprovadas",
                value: t.aprovada,
                color: "#22c55e"
            }, {
                label: "Rejeitadas",
                value: t.rejeitada,
                color: "#ef4444"
            }].filter(e => e.value > 0);
        let r = 0;
        return React.createElement("div", {
            className: "bg-white rounded-xl shadow p-6"
        }, React.createElement("h2", {
            className: "text-lg font-semibold mb-4"
        }, "📈 Distribuição por Status"), 0 === a ? React.createElement("p", {
            className: "text-gray-500"
        }, "Nenhuma solicitação") : React.createElement("div", {
            className: "flex flex-col md:flex-row items-center gap-6"
        }, React.createElement("svg", {
            viewBox: "0 0 200 200",
            className: "w-48 h-48"
        }, l.map((e, t) => {
            const l = e.value / a * 360,
                o = r;
            r += l;
            const c = 100 + 90 * Math.cos((o - 90) * Math.PI / 180),
                s = 100 + 90 * Math.sin((o - 90) * Math.PI / 180),
                n = 100 + 90 * Math.cos((o + l - 90) * Math.PI / 180),
                m = 100 + 90 * Math.sin((o + l - 90) * Math.PI / 180),
                i = l > 180 ? 1 : 0;
            return React.createElement("path", {
                key: t,
                d: `M 100 100 L ${c} ${s} A 90 90 0 ${i} 1 ${n} ${m} Z`,
                fill: e.color,
                stroke: "white",
                strokeWidth: "2"
            })
        }), React.createElement("circle", {
            cx: "100",
            cy: "100",
            r: "50",
            fill: "white"
        }), React.createElement("text", {
            x: "100",
            y: "95",
            textAnchor: "middle",
            className: "text-2xl font-bold",
            fill: "#1f2937"
        }, a), React.createElement("text", {
            x: "100",
            y: "110",
            textAnchor: "middle",
            className: "text-xs",
            fill: "#6b7280"
        }, "Total")), React.createElement("div", {
            className: "flex-1 space-y-2"
        }, l.map((e, t) => React.createElement("div", {
            key: t,
            className: "flex items-center gap-2"
        }, React.createElement("div", {
            className: "w-4 h-4 rounded",
            style: {
                backgroundColor: e.color
            }
        }), React.createElement("span", {
            className: "text-sm flex-1"
        }, e.label), React.createElement("span", {
            className: "font-semibold"
        }, e.value), React.createElement("span", {
            className: "text-gray-500 text-sm"
        }, "(", (e.value / a * 100).toFixed(1), "%)"))))))
    },
    MotivosPieChart = ({
        submissions: e
    }) => {
        const t = {};
        e.forEach(e => {
            t[e.motivo] = (t[e.motivo] || 0) + 1
        });
        const a = ["#7c3aed", "#2563eb", "#059669", "#dc2626", "#ea580c", "#8b5cf6"],
            l = e.length,
            r = Object.entries(t).map(([e, t], r) => ({
                motivo: e,
                count: t,
                percentage: (t / l * 100).toFixed(1),
                color: a[r % a.length]
            }));
        let o = 0;
        return React.createElement("div", {
            className: "bg-white rounded-xl shadow p-6"
        }, React.createElement("h2", {
            className: "text-lg font-semibold mb-4"
        }, "📊 Distribuição por Motivo"), 0 === l ? React.createElement("p", {
            className: "text-gray-500"
        }, "Nenhuma solicitação") : React.createElement("div", {
            className: "flex flex-col md:flex-row items-center gap-6"
        }, React.createElement("svg", {
            viewBox: "0 0 200 200",
            className: "w-48 h-48"
        }, r.map((e, t) => {
            const a = e.count / l * 360,
                r = o;
            o += a;
            const c = 100 + 90 * Math.cos((r - 90) * Math.PI / 180),
                s = 100 + 90 * Math.sin((r - 90) * Math.PI / 180),
                n = 100 + 90 * Math.cos((r + a - 90) * Math.PI / 180),
                m = 100 + 90 * Math.sin((r + a - 90) * Math.PI / 180),
                i = a > 180 ? 1 : 0;
            return React.createElement("path", {
                key: t,
                d: `M 100 100 L ${c} ${s} A 90 90 0 ${i} 1 ${n} ${m} Z`,
                fill: e.color,
                stroke: "white",
                strokeWidth: "2"
            })
        }), React.createElement("circle", {
            cx: "100",
            cy: "100",
            r: "50",
            fill: "white"
        }), React.createElement("text", {
            x: "100",
            y: "95",
            textAnchor: "middle",
            className: "text-2xl font-bold",
            fill: "#1f2937"
        }, l), React.createElement("text", {
            x: "100",
            y: "110",
            textAnchor: "middle",
            className: "text-xs",
            fill: "#6b7280"
        }, "Total")), React.createElement("div", {
            className: "flex-1 space-y-2"
        }, r.map((e, t) => React.createElement("div", {
            key: t,
            className: "flex items-center gap-3"
        }, React.createElement("div", {
            className: "w-4 h-4 rounded",
            style: {
                backgroundColor: e.color
            }
        }), React.createElement("div", {
            className: "flex-1"
        }, React.createElement("p", {
            className: "text-sm font-medium text-gray-800 truncate"
        }, e.motivo), React.createElement("p", {
            className: "text-xs text-gray-500"
        }, e.count, " (", e.percentage, "%)")))))))
    },
    TechRanking = ({
        submissions: e
    }) => {
        const t = {};
        e.forEach(e => {
            const a = e.fullName || "Desconhecido";
            t[a] || (t[a] = {
                total: 0,
                aprovadas: 0,
                rejeitadas: 0,
                pendentes: 0
            }), t[a].total++, "aprovada" === e.status ? t[a].aprovadas++ : "rejeitada" === e.status ? t[a].rejeitadas++ : t[a].pendentes++
        });
        const a = Object.entries(t).map(([e, t]) => ({
            name: e,
            ...t,
            aprovacao: t.total > 0 ? (t.aprovadas / t.total * 100).toFixed(1) : 0
        })).sort((e, t) => t.total - e.total);
        return React.createElement("div", {
            className: "bg-white rounded-xl shadow p-6"
        }, React.createElement("h3", {
            className: "text-lg font-semibold mb-4"
        }, "🏆 Ranking de Profissionais"), 0 === a.length ? React.createElement("p", {
            className: "text-gray-500 text-center py-8"
        }, "Sem dados") : React.createElement("div", {
            className: "space-y-3"
        }, a.map((e, t) => React.createElement("div", {
            key: t,
            className: "flex items-center gap-4 p-3 bg-gray-50 rounded-lg hover:bg-gray-100 transition"
        }, React.createElement("div", {
            className: "text-2xl font-bold w-8 " + (0 === t ? "text-yellow-500" : 1 === t ? "text-gray-400" : 2 === t ? "text-orange-600" : "text-gray-400")
        }, t + 1, "º"), React.createElement("div", {
            className: "flex-1"
        }, React.createElement("p", {
            className: "font-semibold text-gray-800"
        }, e.name), React.createElement("div", {
            className: "flex gap-4 text-sm text-gray-600 mt-1"
        }, React.createElement("span", null, "Total: ", React.createElement("b", null, e.total)), React.createElement("span", {
            className: "text-green-600"
        }, "✓ ", e.aprovadas), React.createElement("span", {
            className: "text-red-600"
        }, "✗ ", e.rejeitadas), React.createElement("span", {
            className: "text-yellow-600"
        }, "⏳ ", e.pendentes))), React.createElement("div", {
            className: "text-right"
        }, React.createElement("div", {
            className: "text-2xl font-bold text-purple-600"
        }, e.aprovacao, "%"), React.createElement("div", {
            className: "text-xs text-gray-500"
        }, "aprovação"))))))
    },
    PaginaIndicacao = ({
        token: e
    }) => {
        const [t, a] = useState(!0), [l, r] = useState(null), [o, c] = useState(null), [s, n] = useState(!1), [m, i] = useState(!1), [d, p] = useState({
            nome: "",
            telefone: ""
        }), x = e => {
            const t = e.replace(/\D/g, "");
            return t.length <= 2 ? `(${t}` : t.length <= 7 ? `(${t.slice(0,2)}) ${t.slice(2)}` : t.length <= 11 ? `(${t.slice(0,2)}) ${t.slice(2,7)}-${t.slice(7)}` : `(${t.slice(0,2)}) ${t.slice(2,7)}-${t.slice(7,11)}`
        };
        React.useEffect(() => {
            if (!e || "undefined" === e || "null" === e) return c("Link inválido"), void a(!1);
            (async () => {
                try {
                    const t = await fetch(`${API_URL}/indicacao-link/validar/${e}`);
                    if (!t.ok) return c("Link inválido ou expirado"), void a(!1);
                    const l = await t.json();
                    r(l.indicador)
                } catch (e) {
                    c("Erro ao validar link")
                }
                a(!1)
            })()
        }, [e]);
        return t ? React.createElement("div", {
            className: "min-h-screen bg-gradient-to-br from-blue-600 to-purple-700 flex items-center justify-center"
        }, React.createElement("div", {
            className: "text-white text-center"
        }, React.createElement("div", {
            className: "animate-spin text-6xl mb-4"
        }, "⏳"), React.createElement("p", {
            className: "text-xl"
        }, "Validando link..."))) : o ? React.createElement("div", {
            className: "min-h-screen bg-gradient-to-br from-red-500 to-red-700 flex items-center justify-center p-4"
        }, React.createElement("div", {
            className: "bg-white rounded-2xl shadow-2xl p-8 max-w-md w-full text-center"
        }, React.createElement("div", {
            className: "text-6xl mb-4"
        }, "❌"), React.createElement("h1", {
            className: "text-2xl font-bold text-red-600 mb-2"
        }, "Link Inválido"), React.createElement("p", {
            className: "text-gray-600 mb-6"
        }, o), React.createElement("p", {
            className: "text-sm text-gray-500"
        }, "Peça um novo link para quem te indicou."))) : s ? React.createElement("div", {
            className: "min-h-screen bg-gradient-to-br from-green-500 to-green-700 flex items-center justify-center p-4"
        }, React.createElement("div", {
            className: "bg-white rounded-2xl shadow-2xl p-8 max-w-md w-full text-center"
        }, React.createElement("div", {
            className: "text-6xl mb-4"
        }, "🎉"), React.createElement("h1", {
            className: "text-2xl font-bold text-green-600 mb-2"
        }, "Cadastro Realizado!"), React.createElement("p", {
            className: "text-gray-600 mb-4"
        }, "Seu cadastro foi enviado com sucesso."), React.createElement("div", {
            className: "bg-green-50 border border-green-200 rounded-lg p-4"
        }, React.createElement("p", {
            className: "text-green-800 text-sm"
        }, "Em breve entraremos em contato pelo número informado.")))) : React.createElement("div", {
            className: "min-h-screen bg-gradient-to-br from-blue-600 to-purple-700 flex items-center justify-center p-4"
        }, React.createElement("div", {
            className: "bg-white rounded-2xl shadow-2xl p-8 max-w-md w-full"
        }, React.createElement("div", {
            className: "text-center mb-6"
        }, React.createElement("div", {
            className: "text-5xl mb-3"
        }, "🚀"), React.createElement("h1", {
            className: "text-2xl font-bold text-gray-800"
        }, "Seja um Entregador!"), React.createElement("p", {
            className: "text-gray-600 mt-2"
        }, "Você foi indicado por ", React.createElement("span", {
            className: "font-bold text-purple-600"
        }, l?.user_name))), React.createElement("form", {
            onSubmit: async t => {
                if (t.preventDefault(), !d.nome.trim() || !d.telefone.trim()) return void alert("Preencha todos os campos");
                const a = d.telefone.replace(/\D/g, "");
                if (a.length < 10 || a.length > 11) alert("Telefone inválido. Use o formato (DD) 99999-9999");
                else {
                    i(!0);
                    try {
                        const t = await fetch(`${API_URL}/indicacao-link/cadastrar`, {
                            method: "POST",
                            headers: {
                                "Content-Type": "application/json"
                            },
                            body: JSON.stringify({
                                token: e,
                                nome: d.nome.trim(),
                                telefone: d.telefone
                            })
                        });
                        if (!t.ok) {
                            const e = await t.json();
                            throw new Error(e.error || "Erro ao cadastrar")
                        }
                        n(!0)
                    } catch (e) {
                        alert(e.message)
                    }
                    i(!1)
                }
            },
            className: "space-y-4"
        }, React.createElement("div", null, React.createElement("label", {
            className: "block text-sm font-semibold text-gray-700 mb-1"
        }, "Nome Completo *"), React.createElement("input", {
            type: "text",
            value: d.nome,
            onChange: e => p({
                ...d,
                nome: e.target.value
            }),
            className: "w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:border-purple-500 focus:outline-none transition-colors",
            placeholder: "Seu nome completo",
            required: !0
        })), React.createElement("div", null, React.createElement("label", {
            className: "block text-sm font-semibold text-gray-700 mb-1"
        }, "WhatsApp *"), React.createElement("input", {
            type: "tel",
            value: d.telefone,
            onChange: e => p({
                ...d,
                telefone: x(e.target.value)
            }),
            className: "w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:border-purple-500 focus:outline-none transition-colors",
            placeholder: "(62) 99999-9999",
            maxLength: 15,
            required: !0
        }), React.createElement("p", {
            className: "text-xs text-gray-500 mt-1"
        }, "Entraremos em contato por este número")), React.createElement("button", {
            type: "submit",
            disabled: m,
            className: "w-full py-4 bg-gradient-to-r from-purple-600 to-blue-600 text-white rounded-xl font-bold text-lg hover:from-purple-700 hover:to-blue-700 transition-all disabled:opacity-50"
        }, m ? "⏳ Enviando..." : "📤 Enviar Cadastro")), React.createElement("div", {
            className: "mt-6 text-center"
        }, React.createElement("p", {
            className: "text-xs text-gray-400"
        }, "Ao enviar, você concorda em ser contatado sobre oportunidades de trabalho."))))
    },
    App = () => {
        const [e, t] = useState(window.location.hash || "");
        React.useEffect(() => {
            const e = () => {
                t(window.location.hash || "")
            };
            return window.addEventListener("hashchange", e), () => window.removeEventListener("hashchange", e)
        }, []);
        const a = e.match(/#\/indicar\/([A-Za-z0-9]+)/);
        if (a && a[1]) return React.createElement(PaginaIndicacao, {
            token: a[1]
        });
        const [l, r] = useState(() => {
            try {
                const e = sessionStorage.getItem("tutts_user");
                return e ? JSON.parse(e) : null
            } catch {
                return null
            }
        }), o = e => {
            e ? sessionStorage.setItem("tutts_user", JSON.stringify(e)) : sessionStorage.removeItem("tutts_user"), r(e)
        }, [c, s] = useState(!1), [n, m] = useState(!1), [i, d] = useState(null), [p, x] = useState({}), [u, g] = useState(null), [b, R] = useState(Date.now()), [E, h] = useState(null), [f, N] = useState(!1), [y, v] = useState({
            solicitacoes: 0,
            validacao: 0,
            loja: 0,
            gratuidades: 0
        }), [w, _] = useState({
            solicitacoes: [],
            validacao: [],
            loja: [],
            gratuidades: []
        }), [j, C] = useState([]), [A, S] = useState([]), [k, P] = useState(!1), [T, D] = useState(null), [L, I] = useState([]), [F, $] = useState(!1), [M, O] = useState([]), [q, U] = useState([]), [z, B] = useState([]), [V, J] = useState(null), [Q, H] = useState([]), [G, W] = useState([]), [Z, Y] = useState([]), [K, X] = useState({}), [ee, te] = useState([]), [ae, le] = useState([]), [re, oe] = useState([]), [ce, se] = useState([]), [ne, me] = useState([]), [ie, de] = useState([]), [pe, xe] = useState([]), [ue, ge] = useState(!1), [be, Re] = useState(null), [Ee, he] = useState("solicitacoes"), [fe, Ne] = useState({
            titulo: "Acerte os procedimentos e ganhe saque gratuito de R$ 500,00",
            imagens: [null, null, null, null],
            perguntas: [{
                texto: "",
                resposta: !0
            }, {
                texto: "",
                resposta: !0
            }, {
                texto: "",
                resposta: !0
            }, {
                texto: "",
                resposta: !0
            }, {
                texto: "",
                resposta: !0
            }],
            valor_gratuidade: 500,
            ativo: !1
        }), [ye, ve] = useState([]), [we, _e] = useState(!1), [je, Ce] = useState(null), [Ae, Se] = useState(0), [ke, Pe] = useState(0), [Te, De] = useState([null, null, null, null, null]), [Le, Ie] = useState(null), [Fe, $e] = useState(!1), [Me, Oe] = useState({
            horarios: [],
            especiais: [],
            loading: !0
        }), [qe, Ue] = useState({
            avisos: [],
            loading: !0
        }), [ze, Be] = useState(null), [Ve, Je] = useState(0), [Qe, He] = useState([]), [Ge, We] = useState(!1), [Ze, Ye] = useState([]), [Ke, Xe] = useState([]), [et, tt] = useState([]), [at, lt] = useState([]), [rt, ot] = useState(!0), [ct, st] = useState(0), [nt, mt] = useState("produtos"), [it, dt] = useState([]), [pt, xt] = useState("lista"), [ut, gt] = useState([]), [bt, Rt] = useState([]), [Et, ht] = useState("dashboard"), [ft, Nt] = useState(null), [yt, vt] = useState([]), [wt, _t] = useState([{
            km_min: 0,
            km_max: 15,
            prazo_minutos: 45
        }, {
            km_min: 15,
            km_max: 20,
            prazo_minutos: 50
        }, {
            km_min: 20,
            km_max: 30,
            prazo_minutos: 60
        }, {
            km_min: 30,
            km_max: null,
            prazo_minutos: 90
        }]), [jt, Ct] = useState([]), [At, St] = useState([]), [kt, Pt] = useState([]), [Tt, Dt] = useState({}), [Lt, It] = useState([]), [Ft, $t] = useState([]), [Mt, Ot] = useState([]), [qt, Ut] = useState([]), [zt, Bt] = useState([]), [Vt, Jt] = useState([]), [Qt, Ht] = useState({
            porTempo: [],
            porKm: []
        }), [Gt, Wt] = useState([]), [Zt, Yt] = useState([]), [Kt, Xt] = useState({}), [ea, ta] = useState([]), [aa, la] = useState([]), [ra, oa] = useState([]), [ca, sa] = useState({
            key: null,
            direction: "desc"
        }), [na, ma] = useState([]), [ia, da] = useState([]), [pa, xa] = useState([]), [ua, ga] = useState({
            data_inicio: "",
            data_fim: "",
            cod_cliente: [],
            centro_custo: [],
            categoria: "",
            status_prazo: "",
            regiao: ""
        }), [ba, Ra] = useState(!1), [Ea, ha] = useState(null), [fa, Na] = useState([{
            km_min: 0,
            km_max: 15,
            prazo_minutos: 45
        }]), [ya, va] = useState([{
            km_min: 0,
            km_max: 15,
            prazo_minutos: 45
        }]), [wa, _a] = useState(!1), [todoGrupos, setTodoGrupos] = useState([]), [todoTarefas, setTodoTarefas] = useState([]), [todoGrupoAtivo, setTodoGrupoAtivo] = useState(null), [todoMetricas, setTodoMetricas] = useState(null), [todoTab, setTodoTab] = useState("tarefas"), [todoFiltroStatus, setTodoFiltroStatus] = useState("todas"), [todoModal, setTodoModal] = useState(null), [todoLoading, setTodoLoading] = useState(false), [todoAdmins, setTodoAdmins] = useState([]), ja = (e, t = "success") => {
            d({
                message: e,
                type: t
            }), setTimeout(() => d(null), 3e3)
        };
        useEffect(() => {
            if (!l) return;
            const e = () => R(Date.now()),
                t = ["mousedown", "mousemove", "keydown", "scroll", "touchstart", "click"];
            t.forEach(t => window.addEventListener(t, e));
            const a = setInterval(() => {
                Date.now() - b > 9e5 && (ja("⏰ Sessão expirada", "error"), setTimeout(() => {
                    o(null), x({})
                }, 1500))
            }, 3e4);
            return () => {
                t.forEach(t => window.removeEventListener(t, e)), clearInterval(a)
            }
        }, [l, b]), useEffect(() => {
            l || "register" !== p.view || 0 !== pe.length || Ta()
        }, [p.view]), useEffect(() => (document.body.style.overflow = wa ? "hidden" : "auto", () => {
            document.body.style.overflow = "auto"
        }), [wa]), useEffect(() => {
            if ("register" === p.view && p.cod && pe.length > 0) {
                const e = Da(p.cod);
                x(e ? t => ({
                    ...t,
                    name: e,
                    codValido: !0
                }) : e => ({
                    ...e,
                    name: "",
                    codValido: !1
                }))
            }
        }, [p.cod, p.view, pe]), useEffect(() => {
            if (!l) return;
            const e = async e => {
                try {
                    await e()
                } catch (e) {
                    console.log("Background load error:", e)
                }
            }, t = () => {
                "user" === l.role && (e($a), e(qa), e(vl), e(_l), e(Al), e(kl), e(Dl), e(Il), e(Za), e(Ka)), "admin_financeiro" !== l.role && "admin_master" !== l.role || (e(za), e(Ba), e(gl), e(wl), e(Cl), e(Sl), e(Dl), e(Ll), e(Ia), e(Ja), e(Ha), e(Wa), e(Ya)), "admin" !== l.role && "admin_master" !== l.role || e(Ia), e(La)
            };
            (async () => {
                "user" === l.role && await Promise.all([Oa(), Ga()]), "admin_financeiro" !== l.role && "admin_master" !== l.role || await Promise.all([Ua(), Va()])
            })().then(() => {
                setTimeout(t, 100)
            })
        }, [l]);
        const Ca = () => {
                try {
                    const e = new(window.AudioContext || window.webkitAudioContext),
                        t = e.createOscillator(),
                        a = e.createGain();
                    t.connect(a), a.connect(e.destination), t.frequency.value = 800, t.type = "sine", a.gain.value = .3, t.start(), setTimeout(() => {
                        t.frequency.value = 600
                    }, 150), setTimeout(() => {
                        t.frequency.value = 800
                    }, 300), setTimeout(() => {
                        t.stop()
                    }, 450)
                } catch (e) {
                    console.log("Audio não suportado")
                }
            },
            Aa = React.useRef(0),
            Sa = React.useRef(0),
            ka = React.useRef({
                solicitacoes: new Set,
                loja: new Set,
                gratuidades: new Set
            }),
            Pa = e => {
                if ("solicitacoes" === e || "validacao" === e) {
                    const e = q.filter(e => "pending" === e.status).map(e => e.id);
                    ka.current.solicitacoes = new Set([...ka.current.solicitacoes, ...e]), v(e => ({
                        ...e,
                        solicitacoes: 0,
                        validacao: 0
                    }))
                } else if ("loja" === e) {
                    const e = et.filter(e => "pendente" === e.status).map(e => e.id);
                    ka.current.loja = new Set([...ka.current.loja, ...e]), v(e => ({
                        ...e,
                        loja: 0
                    }))
                } else if ("gratuidades" === e) {
                    const e = Q.filter(e => "pending" === e.status).map(e => e.id);
                    ka.current.gratuidades = new Set([...ka.current.gratuidades, ...e]), v(e => ({
                        ...e,
                        gratuidades: 0
                    }))
                }
            };
        useEffect(() => {
            if (!l || "admin_financeiro" !== l.role && ("admin_master" !== l.role || "financeiro" !== Ee)) return;
            const e = async () => {
                N(!0);
                const e = p.finTab || "solicitacoes";
                try {
                    const [t, a, l] = await Promise.all([fetch(`${API_URL}/withdrawals`), fetch(`${API_URL}/loja/pedidos`), fetch(`${API_URL}/gratuities`)]), r = await t.json(), o = await a.json(), c = await l.json(), s = r.filter(e => "pending" === e.status && !ka.current.solicitacoes.has(e.id)), n = o.filter(e => "pendente" === e.status && !ka.current.loja.has(e.id)), m = c.filter(e => "pending" === e.status && !ka.current.gratuidades.has(e.id));
                    v({
                        solicitacoes: s.length,
                        validacao: s.length,
                        loja: n.length,
                        gratuidades: m.length
                    });
                    const i = Aa.current,
                        d = r.filter(e => "pending" === e.status).length;
                    d > i && i > 0 && (Ca(), ja("🔔 Novo saque solicitado!", "info")), Aa.current = d;
                    const p = Sa.current,
                        x = o.filter(e => "pendente" === e.status).length;
                    switch (x > p && p > 0 && (Ca(), ja("🛒 Novo pedido na loja!", "info")), Sa.current = x, U(r), tt(o), H(c), e) {
                        case "restritos":
                            await Ba();
                            break;
                        case "indicacoes":
                            await vl(), await jl(), await _l();
                            break;
                        case "promo-novatos":
                            await Cl(), await Sl(), await Ll();
                            break;
                        case "resumo":
                            await Va();
                            break;
                        case "loja":
                            await Ja(), await Ha()
                    }
                    "solicitacoes" === e || "validacao" === e ? Pa("solicitacoes") : "loja" === e ? Pa("loja") : "gratuidades" === e && Pa("gratuidades"), h(new Date)
                } catch (e) {
                    console.error("Erro no polling:", e)
                }
                N(!1)
            };
            e();
            const t = setInterval(e, 1e4);
            return () => clearInterval(t)
        }, [l, p.finTab, Ee]), useEffect(() => {
            if (!l || "admin" !== l.role) return;
            const e = setInterval(async () => {
                N(!0);
                try {
                    await La(), h(new Date)
                } catch (e) {
                    console.error("Erro no polling:", e)
                }
                N(!1)
            }, 6e4);
            return () => clearInterval(e)
        }, [l]), useEffect(() => {
            if (!l || !["admin", "admin_master"].includes(l.role)) return;
            if ("disponibilidade" !== p.adminTab) return;
            const e = setInterval(async () => {
                try {
                    const e = await fetch(`${API_URL}/disponibilidade`);
                    if (!e.ok) return;
                    const t = await e.json();
                    x(e => ({
                        ...e,
                        dispData: t
                    })), console.log("🔄 Disponibilidade atualizada em tempo real")
                } catch (e) {
                    console.error("Erro no polling disponibilidade:", e)
                }
            }, 1e4);
            return () => clearInterval(e)
        }, [l, p.adminTab]), useEffect(() => {
            if (!l || !["admin", "admin_master", "admin_financeiro"].includes(l.role)) return;
            if ("horarios" !== p.finTab) return;
            (async () => {
                try {
                    const [e, t] = await Promise.all([fetch(`${API_URL}/horarios`).then(e => e.json()), fetch(`${API_URL}/horarios/especiais`).then(e => e.json())]);
                    console.log("Horários especiais recebidos:", t), Oe({
                        horarios: e,
                        especiais: t,
                        loading: !1
                    })
                } catch (e) {
                    console.error("Erro ao carregar horários:", e), Oe(e => ({
                        ...e,
                        loading: !1
                    }))
                }
            })()
        }, [l, p.finTab]), useEffect(() => {
            if (!l || !["admin", "admin_master", "admin_financeiro"].includes(l.role)) return;
            if ("avisos" !== p.finTab) return;
            (async () => {
                try {
                    const e = await fetch(`${API_URL}/avisos`),
                        t = await e.json();
                    Ue({
                        avisos: t,
                        loading: !1
                    })
                } catch (e) {
                    console.error("Erro ao carregar avisos:", e), Ue(e => ({
                        ...e,
                        loading: !1
                    }))
                }
            })()
        }, [l, p.finTab]), useEffect(() => {
            if (!l || "user" !== l.role) return;
            if ("saque" !== p.userTab) return;
            We(!1), Je(0), Be(null);
            (async () => {
                try {
                    const [e, t] = await Promise.all([fetch(`${API_URL}/horarios/verificar`).then(e => e.json()), fetch(`${API_URL}/avisos?ativos=true`).then(e => e.json())]);
                    Be(e);
                    const a = t.filter(t => !t.exibir_fora_horario || t.exibir_fora_horario && !e.dentroHorario);
                    He(a)
                } catch (e) {
                    console.error("Erro ao verificar horário:", e), Be({
                        dentroHorario: !0
                    })
                }
            })()
        }, [l, p.userTab]), useEffect(() => {
            T && T.pix_tipo && x(e => ({
                ...e,
                pixTipo: T.pix_tipo,
                finPix: T.pix_key || "",
                finName: T.full_name || "",
                finCpf: T.cpf || ""
            }))
        }, [T]);
        const loadTodoGrupos = async () => {
            try {
                const res = await fetch(`${API_URL}/todo/grupos?user_cod=${l.codProfissional}&role=${l.role}`);
                return await res.json()
            } catch (err) {
                console.error("Erro:", err);
                return []
            }
        };
        const loadTodoTarefas = async (grupoId, status = "todas") => {
            try {
                let url = `${API_URL}/todo/tarefas?user_cod=${l.codProfissional}&role=${l.role}`;
                if (grupoId) url += `&grupo_id=${grupoId}`;
                if (status !== "todas") url += `&status=${status}`;
                const res = await fetch(url);
                return await res.json()
            } catch (err) {
                console.error("Erro:", err);
                return []
            }
        };
        const loadTodoMetricas = async (periodo = "30") => {
            try {
                const res = await fetch(`${API_URL}/todo/metricas?periodo=${periodo}`);
                return await res.json()
            } catch (err) {
                console.error("Erro:", err);
                return null
            }
        };
        const loadTodoAdmins = async () => {
            try {
                const res = await fetch(`${API_URL}/todo/admins`);
                return await res.json()
            } catch (err) {
                return []
            }
        };
        useEffect(() => {
            if (!(l && ("admin_master" === l.role || "admin" === l.role) && "todo" === Ee)) return;
            const init = async () => {
                setTodoLoading(true);
                const [grupos, admins] = await Promise.all([loadTodoGrupos(), loadTodoAdmins()]);
                setTodoGrupos(grupos);
                setTodoAdmins(admins);
                if (grupos.length > 0) {
                    setTodoGrupoAtivo(grupos[0]);
                    const tarefas = await loadTodoTarefas(grupos[0].id);
                    setTodoTarefas(tarefas)
                }
                if ("admin_master" === l.role) {
                    const metricas = await loadTodoMetricas();
                    setTodoMetricas(metricas)
                }
                setTodoLoading(false)
            };
            init()
        }, [Ee, l]);
        const Ta = async () => {
            ge(!0), Re(null);
            try {
                const e = await fetch("https://docs.google.com/spreadsheets/d/e/2PACX-1vQTbc5J8j85MlYGrjWajG33cTDd6TEpYur5hgNcYUwmtra8jh3Nfsrzm-0GNJO6wCYEZAGEHxw807o7/pub?gid=0&single=true&output=tsv"),
                    t = (await e.text()).split("\n").filter(e => e.trim()),
                    a = [];
                for (let e = 1; e < t.length; e++) {
                    const l = t[e].split("\t"),
                        r = l[0]?.trim(),
                        o = l[1]?.trim();
                    r && o && a.push({
                        codigo: r,
                        nome: o
                    })
                }
                xe(a), console.log(`📊 Planilha carregada: ${a.length} profissionais`)
            } catch (e) {
                console.error("Erro ao carregar planilha:", e), Re("Erro ao carregar lista de profissionais")
            }
            ge(!1)
        }, Da = e => {
            if (!e || 0 === pe.length) return null;
            const t = pe.find(t => t.codigo === e.toString());
            return t ? t.nome : null
        }, La = async () => {
            try {
                const e = "user" === l.role ? `?userId=${l.id}&userCod=${l.cod_profissional}` : "",
                    t = await fetch(`${API_URL}/submissions${e}`),
                    a = await t.json();
                C(a.map(e => ({
                    ...e,
                    ordemServico: e.ordem_servico,
                    codProfissional: e.user_cod,
                    fullName: e.user_name,
                    temImagem: e.tem_imagem,
                    imagemComprovante: null,
                    timestamp: new Date(e.created_at).toLocaleString("pt-BR")
                })))
            } catch (e) {
                console.error(e)
            }
        }, Ia = async () => {
            try {
                const e = await fetch(`${API_URL}/users`),
                    t = await e.json();
                S(t.map(e => ({
                    codProfissional: e.cod_profissional,
                    fullName: e.full_name,
                    role: e.role,
                    createdAt: new Date(e.created_at).toLocaleString("pt-BR")
                })))
            } catch (e) {
                console.error(e)
            }
        }, Fa = async e => {
            try {
                const t = await fetch(`${API_URL}/submissions/${e}/imagem`),
                    a = await t.json();
                C(t => t.map(t => t.id === e ? {
                    ...t,
                    imagemComprovante: a.imagem
                } : t))
            } catch (e) {
                ja("Erro ao carregar imagem", "error")
            }
        }, $a = async () => {
            try {
                const e = await fetch(`${API_URL}/financial/check-terms/${l.cod_profissional}`),
                    t = await e.json();
                if (P(t.hasAccepted), t.hasAccepted) {
                    const e = await fetch(`${API_URL}/financial/data/${l.cod_profissional}`),
                        t = await e.json();
                    D(t.data), Ma()
                }
            } catch (e) {
                console.error(e)
            }
        }, Ma = async () => {
            try {
                const e = await fetch(`${API_URL}/financial/logs/${l.cod_profissional}`),
                    t = await e.json();
                I(t)
            } catch (e) {
                console.error(e)
            }
        }, Oa = async () => {
            try {
                const e = await fetch(`${API_URL}/withdrawals/user/${l.cod_profissional}`);
                O(await e.json())
            } catch (e) {
                console.error(e)
            }
        }, qa = async () => {
            try {
                const e = await fetch(`${API_URL}/gratuities/user/${l.cod_profissional}`);
                W(await e.json())
            } catch (e) {
                console.error(e)
            }
        }, Ua = async () => {
            try {
                const e = await fetch(`${API_URL}/withdrawals`);
                U(await e.json())
            } catch (e) {
                console.error(e)
            }
        }, za = async () => {
            try {
                const e = await fetch(`${API_URL}/gratuities`);
                H(await e.json())
            } catch (e) {
                console.error(e)
            }
        }, Ba = async () => {
            try {
                const e = await fetch(`${API_URL}/restricted`);
                Y(await e.json())
            } catch (e) {
                console.error(e)
            }
        }, Va = async () => {
            try {
                const e = await fetch(`${API_URL}/withdrawals/dashboard/conciliacao`);
                X(await e.json())
            } catch (e) {
                console.error(e)
            }
        }, Ja = async () => {
            try {
                const e = await fetch(`${API_URL}/loja/estoque`);
                Ye(await e.json())
            } catch (e) {
                console.error("Erro ao carregar estoque:", e)
            }
        }, Qa = async () => {
            try {
                const e = await fetch(`${API_URL}/loja/movimentacoes`);
                dt(await e.json())
            } catch (e) {
                console.error("Erro ao carregar movimentações:", e)
            }
        }, Ha = async () => {
            try {
                const e = await fetch(`${API_URL}/loja/produtos`);
                Xe(await e.json())
            } catch (e) {
                console.error("Erro ao carregar produtos:", e)
            }
        }, Ga = async () => {
            try {
                const e = await fetch(`${API_URL}/loja/produtos/ativos`);
                Xe(await e.json())
            } catch (e) {
                console.error("Erro ao carregar produtos:", e)
            }
        }, Wa = async () => {
            try {
                const e = await fetch(`${API_URL}/loja/pedidos`);
                tt(await e.json())
            } catch (e) {
                console.error("Erro ao carregar pedidos:", e)
            }
        }, Za = async () => {
            try {
                const e = await fetch(`${API_URL}/loja/pedidos/user/${l.codProfissional}`);
                lt(await e.json())
            } catch (e) {
                console.error("Erro ao carregar pedidos:", e)
            }
        }, Ya = async () => {
            try {
                const e = await fetch(`${API_URL}/loja/sugestoes`);
                gt(await e.json())
            } catch (e) {
                console.error("Erro ao carregar sugestões:", e)
            }
        }, Ka = async () => {
            try {
                const e = await fetch(`${API_URL}/loja/sugestoes/user/${l.codProfissional}`);
                Rt(await e.json())
            } catch (e) {
                console.error("Erro ao carregar sugestões:", e)
            }
        }, Xa = () => {
            const e = new URLSearchParams;
            return ua.data_inicio && e.append("data_inicio", ua.data_inicio), ua.data_fim && e.append("data_fim", ua.data_fim), ua.cod_cliente && e.append("cod_cliente", ua.cod_cliente), ua.centro_custo && e.append("centro_custo", ua.centro_custo), ua.cod_prof && e.append("cod_prof", ua.cod_prof), ua.categoria && e.append("categoria", ua.categoria), ua.cidade && e.append("cidade", ua.cidade), ua.status_prazo && e.append("status_prazo", ua.status_prazo), e
        }, el = async () => {
            try {
                Ra(!0);
                const e = Xa();
                console.log("📊 Carregando dashboard com filtros:", e.toString() || "(sem filtros)");
                const t = await fetch(`${API_URL}/bi/dashboard-completo?${e}`),
                    a = await t.json();
                console.log("📊 Dados recebidos:", a), Nt(a.metricas || {}), Bt(a.porCliente || []), Jt(a.porProfissional || []);
                const l = a.dadosGraficos || [],
                    r = [{
                        label: "0 a 45 min",
                        min: 0,
                        max: 45
                    }, {
                        label: "45-60 min",
                        min: 45,
                        max: 60
                    }, {
                        label: "60-75 min",
                        min: 60,
                        max: 75
                    }, {
                        label: "75-90 min",
                        min: 75,
                        max: 90
                    }, {
                        label: "90 a 120 min",
                        min: 90,
                        max: 120
                    }, {
                        label: "> 120 min",
                        min: 120,
                        max: 99999
                    }].map(e => ({
                        faixa: e.label,
                        total: l.filter(t => {
                            const a = parseFloat(t.tempo);
                            return null !== a && !isNaN(a) && a >= e.min && a < e.max
                        }).length
                    })),
                    o = [{
                        label: "0-10",
                        min: 0,
                        max: 10
                    }, {
                        label: "11-15",
                        min: 10,
                        max: 15
                    }, {
                        label: "16-20",
                        min: 15,
                        max: 20
                    }, {
                        label: "21-25",
                        min: 20,
                        max: 25
                    }, {
                        label: "26-30",
                        min: 25,
                        max: 30
                    }, {
                        label: "31-35",
                        min: 30,
                        max: 35
                    }, {
                        label: "36-40",
                        min: 35,
                        max: 40
                    }, {
                        label: "41-45",
                        min: 40,
                        max: 45
                    }, {
                        label: "46-50",
                        min: 45,
                        max: 50
                    }, {
                        label: "51-55",
                        min: 50,
                        max: 55
                    }, {
                        label: "56-60",
                        min: 55,
                        max: 60
                    }, {
                        label: "61-65",
                        min: 60,
                        max: 65
                    }, {
                        label: "66-70",
                        min: 65,
                        max: 70
                    }, {
                        label: "Outras",
                        min: 70,
                        max: 99999
                    }].map(e => ({
                        faixa: e.label,
                        total: l.filter(t => {
                            const a = parseFloat(t.km);
                            return null !== a && !isNaN(a) && a >= e.min && a < e.max
                        }).length
                    }));
                Ht({
                    porTempo: r,
                    porKm: o
                })
            } catch (e) {
                console.error("Erro ao carregar BI:", e)
            }
            Ra(!1)
        }, tl = async () => {
            try {
                const e = await fetch(`${API_URL}/bi/prazos`);
                vt(await e.json())
            } catch (e) {
                console.error("Erro ao carregar prazos:", e)
            }
        }, al = async () => {
            try {
                const e = await fetch(`${API_URL}/bi/prazo-padrao`),
                    t = await e.json();
                t && t.length > 0 && (_t(t), Na(t))
            } catch (e) {
                console.error("Erro ao carregar prazo padrão:", e)
            }
        }, ll = async () => {
            try {
                const [e, t, a, l, r, o, c, s, n, m] = await Promise.all([fetch(`${API_URL}/bi/clientes`).then(e => e.json()), fetch(`${API_URL}/bi/centros-custo`).then(e => e.json()), fetch(`${API_URL}/bi/profissionais`).then(e => e.json()), fetch(`${API_URL}/bi/datas`).then(e => e.json()), fetch(`${API_URL}/bi/uploads`).then(e => e.json()), fetch(`${API_URL}/bi/cidades`).then(e => e.json()).catch(() => []), fetch(`${API_URL}/bi/cliente-centros`).then(e => e.json()).catch(() => ({})), fetch(`${API_URL}/bi/categorias`).then(e => e.json()).catch(() => []), fetch(`${API_URL}/bi/regioes`).then(e => e.json()).catch(() => []), fetch(`${API_URL}/bi/dados-filtro`).then(e => e.json()).catch(() => [])]), i = (e || []).sort((e, t) => (parseInt(e.cod_cliente) || 0) - (parseInt(t.cod_cliente) || 0));
                if (Ct(i), St(t || []), Pt(t || []), Dt(c || {}), It(a || []), $t(l || []), Ot(r || []), Yt(o || []), oa(s || []), xa(s || []), la(n || []), ma(m || []), da(i), l && l.length > 0) {
                    const e = e => {
                            if (!e) return "";
                            return new Date(e).toISOString().split("T")[0]
                        },
                        t = {
                            ...ua,
                            data_inicio: e(l[l.length - 1].data),
                            data_fim: e(l[0].data),
                            cod_cliente: [],
                            centro_custo: []
                        };
                    console.log("📊 Datas formatadas:", t.data_inicio, "até", t.data_fim), ga(t), setTimeout(() => ol(t), 100)
                } else ol({})
            } catch (e) {
                console.error("Erro ao carregar dropdowns:", e)
            }
        }, rl = e => {
            const t = na;
            if (!t || 0 === t.length) return da(jt), Pt(At), void xa(ra);
            let a = e.cod_cliente || [];
            if (e.regiao) {
                const t = aa.find(t => t.id === parseInt(e.regiao));
                t && t.clientes && (a = t.clientes.map(e => String(e)))
            }
            let l = t;
            if (a.length > 0 && (l = l.filter(e => a.includes(String(e.cod_cliente)))), e.categoria && (l = l.filter(t => t.categoria === e.categoria)), e.centro_custo && e.centro_custo.length > 0 && (l = l.filter(t => e.centro_custo.includes(t.centro_custo))), 0 === a.length) {
                const e = [...new Set(l.map(e => e.cod_cliente))];
                da(jt.filter(t => e.includes(t.cod_cliente)))
            } else {
                let a = t;
                e.categoria && (a = a.filter(t => t.categoria === e.categoria)), e.centro_custo && e.centro_custo.length > 0 && (a = a.filter(t => e.centro_custo.includes(t.centro_custo)));
                const l = [...new Set(a.map(e => e.cod_cliente))];
                da(jt.filter(e => l.includes(e.cod_cliente)))
            }
            let r = t;
            a.length > 0 && (r = r.filter(e => a.includes(String(e.cod_cliente)))), e.categoria && (r = r.filter(t => t.categoria === e.categoria));
            const o = [...new Set(r.map(e => e.centro_custo).filter(e => e))];
            Pt(At.filter(e => o.includes(e.centro_custo)));
            let c = t;
            a.length > 0 && (c = c.filter(e => a.includes(String(e.cod_cliente)))), e.centro_custo && e.centro_custo.length > 0 && (c = c.filter(t => e.centro_custo.includes(t.centro_custo)));
            const s = [...new Set(c.map(e => e.categoria).filter(e => e))];
            xa(s.sort())
        }, ol = async e => {
            try {
                Ra(!0);
                const t = new URLSearchParams;
                e.data_inicio && t.append("data_inicio", e.data_inicio), e.data_fim && t.append("data_fim", e.data_fim), e.cod_cliente && e.cod_cliente.length > 0 && e.cod_cliente.forEach(e => t.append("cod_cliente", e)), e.centro_custo && e.centro_custo.length > 0 && e.centro_custo.forEach(e => t.append("centro_custo", e)), e.cod_prof && t.append("cod_prof", e.cod_prof), e.categoria && t.append("categoria", e.categoria), e.cidade && t.append("cidade", e.cidade), e.status_prazo && t.append("status_prazo", e.status_prazo), console.log("📊 loadBiDashboardComFiltros - params:", t.toString());
                const a = await fetch(`${API_URL}/bi/dashboard-completo?${t}`),
                    l = await a.json();
                console.log("📊 loadBiDashboardComFiltros - resposta:", l), console.log("📊 metricas:", l.metricas), console.log("📊 porCliente:", l.porCliente?.length, "registros"), console.log("📊 porProfissional:", l.porProfissional?.length, "registros"), Nt(l.metricas || {}), Bt(l.porCliente || []), Jt(l.porProfissional || []);
                const r = l.dadosGraficos || [],
                    o = [{
                        label: "0 a 45 min",
                        min: 0,
                        max: 45
                    }, {
                        label: "45-60 min",
                        min: 45,
                        max: 60
                    }, {
                        label: "60-75 min",
                        min: 60,
                        max: 75
                    }, {
                        label: "75-90 min",
                        min: 75,
                        max: 90
                    }, {
                        label: "90 a 120 min",
                        min: 90,
                        max: 120
                    }, {
                        label: "> 120 min",
                        min: 120,
                        max: 99999
                    }].map(e => ({
                        faixa: e.label,
                        total: r.filter(t => {
                            const a = parseFloat(t.tempo);
                            return null !== a && !isNaN(a) && a >= e.min && a < e.max
                        }).length
                    })),
                    c = [{
                        label: "0-10",
                        min: 0,
                        max: 10
                    }, {
                        label: "11-15",
                        min: 10,
                        max: 15
                    }, {
                        label: "16-20",
                        min: 15,
                        max: 20
                    }, {
                        label: "21-25",
                        min: 20,
                        max: 25
                    }, {
                        label: "26-30",
                        min: 25,
                        max: 30
                    }, {
                        label: "31-35",
                        min: 30,
                        max: 35
                    }, {
                        label: "36-40",
                        min: 35,
                        max: 40
                    }, {
                        label: "41-45",
                        min: 40,
                        max: 45
                    }, {
                        label: "46-50",
                        min: 45,
                        max: 50
                    }, {
                        label: "51-55",
                        min: 50,
                        max: 55
                    }, {
                        label: "56-60",
                        min: 55,
                        max: 60
                    }, {
                        label: "61-65",
                        min: 60,
                        max: 65
                    }, {
                        label: "66-70",
                        min: 65,
                        max: 70
                    }, {
                        label: "Outras",
                        min: 70,
                        max: 99999
                    }].map(e => ({
                        faixa: e.label,
                        total: r.filter(t => {
                            const a = parseFloat(t.km);
                            return null !== a && !isNaN(a) && a >= e.min && a < e.max
                        }).length
                    }));
                Ht({
                    porTempo: o,
                    porKm: c
                }), Xt({})
            } catch (e) {
                console.error("Erro ao carregar BI:", e)
            }
            Ra(!1)
        }, cl = e => {
            if (!e && 0 !== e) return "-";
            const t = Math.floor(e / 60),
                a = Math.round(e % 60);
            return t > 0 ? `${String(t).padStart(2,"0")}:${String(a).padStart(2,"0")}:00` : `00:${String(a).padStart(2,"0")}:00`
        }, sl = e => e || 0 === e ? new Intl.NumberFormat("pt-BR", {
            style: "currency",
            currency: "BRL"
        }).format(parseFloat(e) || 0) : "R$0,00", nl = e => parseFloat(e) || 0, ml = e => {
            Xt(t => ({
                ...t,
                [e]: !t[e]
            }))
        }, il = e => {
            const t = ea.find(t => String(t.cod_cliente) === String(e));
            return t ? t.mascara : null
        }, dl = async () => {
            try {
                const e = await fetch(`${API_URL}/bi/mascaras`);
                ta(await e.json())
            } catch (e) {
                console.error("Erro ao carregar máscaras:", e)
            }
        }, pl = async () => {
            try {
                const e = await fetch(`${API_URL}/bi/regioes`);
                la(await e.json())
            } catch (e) {
                console.error("Erro ao carregar regiões:", e)
            }
        }, xl = async () => {
            try {
                Ra(!0);
                const e = await fetch(`${API_URL}/bi/entregas/recalcular`, {
                        method: "POST"
                    }),
                    t = await e.json();
                ja(`✅ ${t.atualizados} entregas recalculadas!`, "success"), el()
            } catch (e) {
                ja("Erro ao recalcular", "error")
            }
            Ra(!1)
        }, ul = async () => {
            m(!0);
            try {
                await La(), "admin" !== l.role && "admin_master" !== l.role || await Ia(), "user" === l.role && (await Oa(), await qa(), await vl(), await _l(), await Ga(), await Za()), "admin_financeiro" !== l.role && "admin_master" !== l.role || (await Ua(), await za(), await Ba(), await Va(), await gl(), await wl(), await Ia(), await Ja(), await Ha(), await Wa()), ja("🔄 Atualizado!", "success")
            } catch (e) {
                ja("Erro", "error")
            }
            m(!1)
        }, gl = async () => {
            try {
                const e = await fetch(`${API_URL}/promocoes`);
                te(await e.json())
            } catch (e) {
                console.error("Erro ao carregar promoções:", e)
            }
        }, bl = ["Domingo", "Segunda-feira", "Terça-feira", "Quarta-feira", "Quinta-feira", "Sexta-feira", "Sábado"], Rl = async (e, t) => {
            try {
                await fetch(`${API_URL}/horarios/${e}`, {
                    method: "PUT",
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify(t)
                }), ja("✅ Horário atualizado!", "success");
                const a = await fetch(`${API_URL}/horarios`),
                    l = await a.json();
                Oe(e => ({
                    ...e,
                    horarios: l
                }))
            } catch (e) {
                ja("Erro ao atualizar", "error")
            }
        }, El = async () => {
            const e = p.novoEspData,
                t = p.novoEspDesc,
                a = p.novoEspFechado,
                l = p.novoEspInicio,
                r = p.novoEspFim;
            if (e) try {
                await fetch(`${API_URL}/horarios/especiais`, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({
                        data: e,
                        descricao: t || "Horário especial",
                        hora_inicio: l,
                        hora_fim: r,
                        fechado: a
                    })
                }), ja("✅ Horário especial criado!", "success"), x(e => ({
                    ...e,
                    novoEspData: "",
                    novoEspDesc: "",
                    novoEspFechado: !1,
                    novoEspInicio: "09:00",
                    novoEspFim: "18:00"
                }));
                const o = await fetch(`${API_URL}/horarios/especiais`),
                    c = await o.json();
                Oe(e => ({
                    ...e,
                    especiais: c
                }))
            } catch (e) {
                ja("Erro ao criar", "error")
            } else ja("Selecione uma data", "error")
        }, hl = async () => {
            const e = p.novoAvisoTitulo,
                t = p.novoAvisoMensagem,
                a = p.novoAvisoTipo || "info",
                l = p.novoAvisoExibirFora || !1;
            if (e && t) try {
                await fetch(`${API_URL}/avisos`, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({
                        titulo: e,
                        mensagem: t,
                        tipo: a,
                        exibir_fora_horario: l
                    })
                }), ja("✅ Aviso criado!", "success"), x(e => ({
                    ...e,
                    novoAvisoTitulo: "",
                    novoAvisoMensagem: "",
                    novoAvisoTipo: "info",
                    novoAvisoExibirFora: !1
                }));
                const r = await fetch(`${API_URL}/avisos`);
                Ue({
                    avisos: await r.json(),
                    loading: !1
                })
            } catch (e) {
                ja("Erro ao criar", "error")
            } else ja("Preencha título e mensagem", "error")
        }, fl = async e => {
            try {
                await fetch(`${API_URL}/avisos/${e.id}`, {
                    method: "PUT",
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({
                        ...e,
                        ativo: !e.ativo
                    })
                });
                const t = await fetch(`${API_URL}/avisos`);
                Ue({
                    avisos: await t.json(),
                    loading: !1
                })
            } catch (e) {
                ja("Erro", "error")
            }
        }, Nl = async e => {
            if (confirm("Remover este aviso permanentemente?")) try {
                await fetch(`${API_URL}/avisos/${e}`, {
                    method: "DELETE"
                }), ja("✅ Removido!", "success");
                const t = await fetch(`${API_URL}/avisos`);
                Ue({
                    avisos: await t.json(),
                    loading: !1
                })
            } catch (e) {
                ja("Erro", "error")
            }
        }, yl = () => {
            if (!ze?.proximoHorario) return "em breve";
            const e = ze.proximoHorario,
                t = new Date(e.data + "T12:00:00"),
                a = new Date;
            a.setHours(0, 0, 0, 0);
            const l = new Date(e.data + "T00:00:00");
            return l.getTime() === a.getTime() ? `hoje às ${e.inicio}` : l.getTime() === a.getTime() + 864e5 ? `amanhã às ${e.inicio}` : `${t.toLocaleDateString("pt-BR",{weekday:"long",day:"numeric",month:"short"})} às ${e.inicio}`
        }, vl = async () => {
            try {
                const e = await fetch(`${API_URL}/promocoes/ativas`);
                te(await e.json())
            } catch (e) {
                console.error("Erro ao carregar promoções ativas:", e)
            }
        }, wl = async () => {
            try {
                const e = await fetch(`${API_URL}/indicacoes`);
                le(await e.json())
            } catch (e) {
                console.error("Erro ao carregar indicações:", e)
            }
        }, _l = async () => {
            try {
                const e = await fetch(`${API_URL}/indicacoes/usuario/${l.codProfissional}`);
                oe(await e.json())
            } catch (e) {
                console.error("Erro ao carregar minhas indicações:", e)
            }
        }, jl = async () => {
            try {
                const e = await fetch(`${API_URL}/indicacao-link/usuario/${l.codProfissional}`),
                    t = await e.json(),
                    a = await fetch(`${API_URL}/indicacao-link/estatisticas/${l.codProfissional}`),
                    r = await a.json();
                await _l(), x(e => ({
                    ...e,
                    meuLinkIndicacao: t,
                    statsIndicacao: r
                }))
            } catch (e) {
                console.error("Erro ao carregar link de indicação:", e)
            }
        }, Cl = async () => {
            try {
                const e = await fetch(`${API_URL}/promocoes-novatos`);
                se(await e.json())
            } catch (e) {
                console.error("Erro ao carregar promoções novatos:", e)
            }
        }, Al = async () => {
            try {
                const e = await fetch(`${API_URL}/promocoes-novatos/ativas`);
                se(await e.json())
            } catch (e) {
                console.error("Erro ao carregar promoções novatos ativas:", e)
            }
        }, Sl = async () => {
            try {
                await fetch(`${API_URL}/inscricoes-novatos/verificar-expiradas`, {
                    method: "POST"
                });
                const e = await fetch(`${API_URL}/inscricoes-novatos`);
                me(await e.json())
            } catch (e) {
                console.error("Erro ao carregar inscrições novatos:", e)
            }
        }, kl = async () => {
            try {
                const e = await fetch(`${API_URL}/inscricoes-novatos/usuario/${l.codProfissional}`);
                de(await e.json())
            } catch (e) {
                console.error("Erro ao carregar minhas inscrições novatos:", e)
            }
        }, Pl = async () => {
            if (p.novatosRegiao && p.novatosCliente && p.novatosValor) {
                s(!0);
                try {
                    if (!(await fetch(`${API_URL}/promocoes-novatos`, {
                            method: "POST",
                            headers: {
                                "Content-Type": "application/json"
                            },
                            body: JSON.stringify({
                                regiao: p.novatosRegiao,
                                cliente: p.novatosCliente,
                                valor_bonus: parseFloat(p.novatosValor),
                                detalhes: p.novatosDetalhes || null,
                                created_by: l.fullName
                            })
                        })).ok) throw new Error("Erro ao criar promoção");
                    ja("✅ Promoção Novatos criada!", "success"), x({
                        ...p,
                        novatosRegiao: "",
                        novatosCliente: "",
                        novatosValor: "",
                        novatosDetalhes: "",
                        editPromoNovatos: null
                    }), await Cl()
                } catch (e) {
                    ja(e.message, "error")
                } finally {
                    s(!1)
                }
            } else ja("Preencha todos os campos obrigatórios", "error")
        }, Tl = async () => {
            s(!0);
            try {
                if (!(await fetch(`${API_URL}/promocoes-novatos/${p.editPromoNovatos.id}`, {
                        method: "PATCH",
                        headers: {
                            "Content-Type": "application/json"
                        },
                        body: JSON.stringify({
                            regiao: p.novatosRegiao,
                            cliente: p.novatosCliente,
                            valor_bonus: parseFloat(p.novatosValor),
                            detalhes: p.novatosDetalhes || null
                        })
                    })).ok) throw new Error("Erro ao editar promoção");
                ja("✅ Promoção atualizada!", "success"), x({
                    ...p,
                    novatosRegiao: "",
                    novatosCliente: "",
                    novatosValor: "",
                    novatosDetalhes: "",
                    editPromoNovatos: null
                }), await Cl()
            } catch (e) {
                ja(e.message, "error")
            } finally {
                s(!1)
            }
        }, Dl = async () => {
            try {
                const e = await fetch(`${API_URL}/quiz-procedimentos/config`),
                    t = await e.json();
                console.log("🎯 Quiz Config carregado:", t), Ne(t)
            } catch (e) {
                console.error("Erro ao carregar config quiz:", e)
            }
        }, Ll = async () => {
            try {
                const e = await fetch(`${API_URL}/quiz-procedimentos/respostas`);
                ve(await e.json())
            } catch (e) {
                console.error("Erro ao carregar respostas quiz:", e)
            }
        }, Il = async () => {
            try {
                const e = await fetch(`${API_URL}/quiz-procedimentos/verificar/${l.codProfissional}`),
                    t = await e.json();
                _e(t.ja_respondeu), t.dados && Ce(t.dados)
            } catch (e) {
                console.error("Erro ao verificar quiz:", e)
            }
        }, Fl = async () => {
            s(!0);
            try {
                if (!(await fetch(`${API_URL}/quiz-procedimentos/config`, {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json"
                        },
                        body: JSON.stringify(fe)
                    })).ok) throw new Error("Erro ao salvar");
                ja("✅ Configuração do Quiz salva!", "success")
            } catch (e) {
                ja(e.message, "error")
            } finally {
                s(!1)
            }
        }, $l = async () => {
            if (Te.some(e => null === e)) ja("Responda todas as perguntas!", "error");
            else {
                s(!0);
                try {
                    const e = await fetch(`${API_URL}/quiz-procedimentos/responder`, {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json"
                        },
                        body: JSON.stringify({
                            user_cod: l.codProfissional,
                            user_name: l.fullName,
                            respostas: Te
                        })
                    });
                    if (!e.ok) {
                        const t = await e.json();
                        throw new Error(t.error || "Erro ao enviar")
                    }
                    const t = await e.json();
                    Ie(t), Se(3), _e(!0), Ce({
                        acertos: t.acertos,
                        passou: t.passou,
                        created_at: (new Date).toISOString()
                    }), t.passou && (ja(`🎉 Parabéns! Você ganhou R$ ${t.valor_gratuidade.toFixed(2).replace(".",",")} de gratuidade!`, "success"), qa())
                } catch (e) {
                    ja(e.message, "error")
                } finally {
                    s(!1)
                }
            }
        }, Ml = async () => {
            if (p.promoRegiao && p.promoValor) {
                s(!0);
                try {
                    if (!(await fetch(`${API_URL}/promocoes`, {
                            method: "POST",
                            headers: {
                                "Content-Type": "application/json"
                            },
                            body: JSON.stringify({
                                regiao: p.promoRegiao,
                                valor_bonus: parseFloat(p.promoValor),
                                detalhes: p.promoDetalhes || null,
                                created_by: l.fullName
                            })
                        })).ok) throw new Error("Erro ao criar promoção");
                    ja("✅ Promoção criada!", "success"), x({
                        ...p,
                        promoRegiao: "",
                        promoValor: "",
                        promoDetalhes: ""
                    }), await gl()
                } catch (e) {
                    ja(e.message, "error")
                }
                s(!1)
            } else ja("Preencha todos os campos obrigatórios", "error")
        }, Ol = async () => {
            if (p.promoRegiao && p.promoValor) {
                s(!0);
                try {
                    if (!(await fetch(`${API_URL}/promocoes/${p.editPromo.id}`, {
                            method: "PATCH",
                            headers: {
                                "Content-Type": "application/json"
                            },
                            body: JSON.stringify({
                                regiao: p.promoRegiao,
                                valor_bonus: parseFloat(p.promoValor),
                                detalhes: p.promoDetalhes || null
                            })
                        })).ok) throw new Error("Erro ao editar promoção");
                    ja("✅ Promoção atualizada!", "success"), x({
                        ...p,
                        editPromo: null,
                        promoRegiao: "",
                        promoValor: "",
                        promoDetalhes: ""
                    }), await gl()
                } catch (e) {
                    ja(e.message, "error")
                }
                s(!1)
            } else ja("Preencha todos os campos obrigatórios", "error")
        }, ql = async () => {
            s(!0);
            try {
                const e = await fetch(`${API_URL}/users/login`, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({
                        codProfissional: p.cod,
                        password: p.password
                    })
                });
                if (!e.ok) throw new Error("Credenciais inválidas");
                const t = await e.json();
                o({
                    ...t,
                    codProfissional: t.cod_profissional,
                    fullName: t.full_name
                }), x({})
            } catch (e) {
                ja(e.message, "error")
            }
            s(!1)
        }, Ul = async () => {
            s(!0);
            try {
                if (!(await fetch(`${API_URL}/users/register`, {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json"
                        },
                        body: JSON.stringify({
                            codProfissional: p.cod,
                            password: p.password,
                            fullName: p.name
                        })
                    })).ok) throw new Error("Erro no cadastro");
                ja("Cadastro realizado!", "success"), x({
                    view: "login"
                })
            } catch (e) {
                ja(e.message, "error")
            }
            s(!1)
        }, zl = async () => {
            s(!0);
            try {
                await fetch(`${API_URL}/financial/accept-terms`, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({
                        userCod: l.codProfissional
                    })
                }), P(!0), ja("✅ Termos aceitos!", "success")
            } catch (e) {
                ja("Erro", "error")
            }
            s(!1)
        }, Bl = async () => {
            if (!p.finName || !p.finCpf || !p.finPix) return void ja("Preencha todos os campos", "error");
            if (!p.pixTipo) return void ja("❌ Selecione o tipo da chave PIX", "error");
            const e = tr(p.finPix, p.pixTipo);
            if (e.valido) {
                s(!0);
                try {
                    await fetch(`${API_URL}/financial/data`, {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json"
                        },
                        body: JSON.stringify({
                            userCod: l.codProfissional,
                            fullName: p.finName,
                            cpf: p.finCpf,
                            pixKey: p.finPix,
                            pixTipo: p.pixTipo
                        })
                    }), D({
                        full_name: p.finName,
                        cpf: p.finCpf,
                        pix_key: p.finPix,
                        pix_tipo: p.pixTipo
                    }), $(!1), Ma();
                    const e = {
                        cpf: "CPF",
                        cnpj: "CNPJ",
                        telefone: "Telefone",
                        email: "Email",
                        aleatoria: "Chave Aleatória"
                    } [p.pixTipo];
                    ja(`✅ Dados salvos! (PIX: ${e})`, "success")
                } catch (e) {
                    ja("Erro ao salvar", "error")
                }
                s(!1)
            } else ja(`❌ ${e.mensagem}`, "error")
        }, Vl = async () => {
            const e = parseFloat(p.withdrawAmount);
            if (!e || e <= 0) return void ja("Valor inválido", "error");
            const t = new Date,
                a = new Date(t.getTime() - 36e5),
                r = M.filter(e => new Date(e.created_at) >= a);
            if (r.length >= 2) {
                const e = new Date(new Date(r[0].created_at).getTime() + 36e5),
                    a = Math.ceil((e - t) / 6e4);
                return void ja(`⚠️ Limite atingido! Você já fez 2 saques na última hora. Aguarde ${a} minutos para solicitar novamente.`, "error")
            }
            if (r.find(t => parseFloat(t.requested_amount) === e)) ja(`⚠️ Valor repetido! Você já solicitou um saque de R$ ${e.toFixed(2)} na última hora. Escolha um valor diferente.`, "error");
            else {
                s(!0);
                try {
                    await fetch(`${API_URL}/withdrawals`, {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json"
                        },
                        body: JSON.stringify({
                            userCod: l.codProfissional,
                            userName: T.full_name,
                            cpf: T.cpf,
                            pixKey: T.pix_key,
                            requestedAmount: e
                        })
                    }), ja("✅ Saque solicitado!", "success"), x({
                        ...p,
                        withdrawAmount: ""
                    }), Oa(), qa()
                } catch (e) {
                    ja("Erro", "error")
                }
                s(!1)
            }
        }, Jl = async (e, t, a = null) => {
            try {
                await fetch(`${API_URL}/withdrawals/${e}`, {
                    method: "PATCH",
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({
                        status: t,
                        adminId: l.id,
                        adminName: l.fullName || "Admin Financeiro",
                        rejectReason: a
                    })
                }), ja("✅ Status atualizado!", "success"), x({
                    ...p,
                    [`reject_${e}`]: "",
                    [`showReject_${e}`]: !1
                }), Ua()
            } catch (e) {
                ja("Erro", "error")
            }
        }, Ql = async (e, t) => {
            try {
                await fetch(`${API_URL}/withdrawals/${e}/saldo`, {
                    method: "PATCH",
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({
                        saldoStatus: t
                    })
                }), Ua(), ja("validado" === t ? "✅ Saldo validado!" : "insuficiente" === t ? "❌ Saldo insuficiente!" : "↩ Status de saldo removido", "success")
            } catch (e) {
                ja("Erro ao atualizar saldo", "error")
            }
        }, Hl = async () => {
            if (p.gratUserCod && p.gratQty && p.gratValue && p.gratUserName) {
                s(!0);
                try {
                    await fetch(`${API_URL}/gratuities`, {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json"
                        },
                        body: JSON.stringify({
                            userCod: p.gratUserCod,
                            userName: p.gratUserName,
                            quantity: parseInt(p.gratQty),
                            value: parseFloat(p.gratValue),
                            reason: p.gratReason || "",
                            createdBy: l.fullName
                        })
                    }), ja("✅ Gratuidade cadastrada!", "success"), x({
                        ...p,
                        gratUserCod: "",
                        gratUserName: "",
                        gratQty: "",
                        gratValue: "",
                        gratReason: ""
                    }), za()
                } catch (e) {
                    ja("Erro", "error")
                }
                s(!1)
            } else ja("Preencha todos os campos obrigatórios", "error")
        }, Gl = async () => {
            if (p.restUserCod && p.restReason && p.restUserName) {
                s(!0);
                try {
                    await fetch(`${API_URL}/restricted`, {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json"
                        },
                        body: JSON.stringify({
                            userCod: p.restUserCod,
                            userName: p.restUserName,
                            reason: p.restReason,
                            createdBy: l.fullName
                        })
                    }), ja("✅ Restrição cadastrada!", "success"), x({
                        ...p,
                        restUserCod: "",
                        restUserName: "",
                        restReason: ""
                    }), Ba()
                } catch (e) {
                    ja("Erro", "error")
                }
                s(!1)
            } else ja("Preencha todos os campos", "error")
        }, Wl = ["Ajuste de Retorno", "Ajuste de Pedágio (Campinas e Recife)"], Zl = (e, t = 800, a = .6) => new Promise((l, r) => {
            const o = new FileReader;
            o.onload = e => {
                const o = new Image;
                o.onload = () => {
                    const e = document.createElement("canvas");
                    let r = o.width,
                        c = o.height;
                    r > t && (c = c * t / r, r = t), e.width = r, e.height = c, e.getContext("2d").drawImage(o, 0, 0, r, c), l(e.toDataURL("image/jpeg", a))
                }, o.onerror = r, o.src = e.target.result
            }, o.onerror = r, o.readAsDataURL(e)
        }), Yl = async () => {
            s(!0);
            try {
                const e = p.imagens?.length > 0 ? p.imagens.join("|||") : null;
                await fetch(`${API_URL}/submissions`, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({
                        ordemServico: p.os,
                        motivo: p.motivo,
                        userId: l.id,
                        userCod: l.codProfissional,
                        userName: l.fullName,
                        imagemComprovante: e,
                        coordenadas: p.coordenadas || null
                    })
                }), ja("✅ OS enviada!", "success"), x({}), La()
            } catch (e) {
                ja("Erro", "error")
            }
            s(!1)
        }, Kl = async (e, t) => {
            try {
                C(a => a.map(a => a.id === e ? {
                    ...a,
                    status: t ? "aprovada" : "rejeitada",
                    validated_by_name: l.fullName
                } : a)), await fetch(`${API_URL}/submissions/${e}`, {
                    method: "PATCH",
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({
                        status: t ? "aprovada" : "rejeitada",
                        observacao: p[`obs_${e}`] || "",
                        validatedBy: l.id,
                        validatedByName: l.fullName || "Admin"
                    })
                }), ja(t ? "✅ Aprovada!" : "❌ Rejeitada!", t ? "success" : "error");
                const {
                    pendingFilter: a,
                    adminTab: r
                } = p;
                x({
                    pendingFilter: a,
                    adminTab: r
                }), La()
            } catch (e) {
                ja("Erro", "error"), La()
            }
        }, Xl = e => {
            const t = e.replace(/\D/g, "").slice(0, 11);
            return t.length <= 3 ? t : t.length <= 6 ? `${t.slice(0,3)}.${t.slice(3)}` : t.length <= 9 ? `${t.slice(0,3)}.${t.slice(3,6)}.${t.slice(6)}` : `${t.slice(0,3)}.${t.slice(3,6)}.${t.slice(6,9)}-${t.slice(9)}`
        }, er = e => parseFloat(e || 0).toLocaleString("pt-BR", {
            style: "currency",
            currency: "BRL"
        }), tr = (e, t) => {
            if (!e || "" === e.trim()) return {
                valido: !1,
                mensagem: ""
            };
            const a = e.trim();
            switch (t) {
                case "cpf":
                    return 11 === a.replace(/\D/g, "").length ? {
                        valido: !0,
                        mensagem: "✅ CPF válido"
                    } : {
                        valido: !1,
                        mensagem: "❌ CPF deve ter 11 dígitos"
                    };
                case "cnpj":
                    return 14 === a.replace(/\D/g, "").length ? {
                        valido: !0,
                        mensagem: "✅ CNPJ válido"
                    } : {
                        valido: !1,
                        mensagem: "❌ CNPJ deve ter 14 dígitos"
                    };
                case "telefone":
                    const e = a.replace(/\D/g, "");
                    return 10 === e.length || 11 === e.length ? {
                        valido: !0,
                        mensagem: "✅ Telefone válido"
                    } : {
                        valido: !1,
                        mensagem: "❌ Telefone deve ter 10 ou 11 dígitos"
                    };
                case "email":
                    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a) ? {
                        valido: !0,
                        mensagem: "✅ Email válido"
                    } : {
                        valido: !1,
                        mensagem: "❌ Formato de email inválido"
                    };
                case "aleatoria":
                    return /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(a) || /^[a-f0-9]{32}$/i.test(a) ? {
                        valido: !0,
                        mensagem: "✅ Chave aleatória válida"
                    } : {
                        valido: !1,
                        mensagem: "❌ Formato de chave aleatória inválido"
                    };
                default:
                    return {
                        valido: !1, mensagem: "Selecione o tipo da chave"
                    }
            }
        }, ar = (e, t) => {
            switch (t) {
                case "cpf":
                    return Xl(e);
                case "cnpj":
                    return (e => {
                        const t = e.replace(/\D/g, "").slice(0, 14);
                        return t.length <= 2 ? t : t.length <= 5 ? `${t.slice(0,2)}.${t.slice(2)}` : t.length <= 8 ? `${t.slice(0,2)}.${t.slice(2,5)}.${t.slice(5)}` : t.length <= 12 ? `${t.slice(0,2)}.${t.slice(2,5)}.${t.slice(5,8)}/${t.slice(8)}` : `${t.slice(0,2)}.${t.slice(2,5)}.${t.slice(5,8)}/${t.slice(8,12)}-${t.slice(12)}`
                    })(e);
                case "telefone":
                    return (e => {
                        const t = e.replace(/\D/g, "").slice(0, 11);
                        return t.length <= 2 ? t.length > 0 ? `(${t}` : "" : t.length <= 7 ? `(${t.slice(0,2)}) ${t.slice(2)}` : `(${t.slice(0,2)}) ${t.slice(2,7)}-${t.slice(7)}`
                    })(e);
                default:
                    return e
            }
        }, lr = e => {
            switch (e) {
                case "cpf":
                    return "000.000.000-00";
                case "cnpj":
                    return "00.000.000/0000-00";
                case "telefone":
                    return "(00) 00000-0000";
                case "email":
                    return "seu@email.com";
                case "aleatoria":
                    return "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx";
                default:
                    return "Selecione o tipo acima"
            }
        };
        if (!l) return React.createElement("div", {
            className: "min-h-screen bg-gradient-to-br from-purple-100 to-purple-200 flex items-center justify-center p-4"
        }, i && React.createElement(Toast, i), React.createElement("div", {
            className: "bg-white rounded-2xl shadow-2xl p-8 w-full max-w-md"
        }, React.createElement("div", {
            className: "text-center mb-8"
        }, React.createElement("img", {
            src: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAHAAAABwCAIAAABJgmMcAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGYktHRAD/AP8A/6C9p5MAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAAHdElNRQfpDAEAESjmv+FkAAADWXpUWHRSYXcgcHJvZmlsZSB0eXBlIHhtcAAASImdVkGSozAMvPsV+wRbsiXzHGLgtlV73Odvt4EAM2RmM0lBApKlltSSHf7+/hN+4ZNUctCmi1ePlkztYcWzRBMr5jbYrJP4vDwej0Uc7wfLfFNcS5405sljVuhWG0KuPjoWFvUxzyUbfmFQFYvEddE5jtq86ujVsNAmOrMkkc/WbHalLNAD0GRbiEPHVfBUB5LNlEDHdCySc7YPZiALENJU9Yxv1BFLF+8fmR1aMtsCRZdFkw784l9UwV1wn1YHMgVXRy7o3atM9AB5RxFHiQcSwEBqELjY4BH6A2KYgWyTB4Ql8IlAiEycy6/Ac+poYcDkM/ruerYUDiUa2/zMqOBiE9SQPSgiLJk17hmjK20XB2PIXXUXn4MpKKynQ3KWAe1whEXyBESDBSU7IkfVyBLp2WC4AmTlQLGbu2LJzFtBjhBQAdFmZBnV0CIT6pNwVzw3We6WHat2F+HWRwHXcx66+QhyVoNpFEW7m4JnUdRYc5dE/AMhK8T8K8rqwheQDFAueMMFnzGd3Bwhhxs84NeGhsZ4wQGMJyBIcEc39WPY4br0q6SiD1EApL8+S8O8bubC14rn0styLv6ZMJSEO87c5OXEtrPJo3HCuXPe77CjwcKrDoOi3syF2GnajplAPdxByAZiYfpwAjy7Kl27qhsdiQdXO+fuwM5ea56/7KiOsz8lm82Js48cctvA8UILgZ5LBFDltGb7wQwGaW6c2ZziRvIhL1yI9z1flmDZcaEnJRZpGsbkfajvi50e+vNZNfeM4ElgfLB1uVnp2Gm+hRUBxCNNyYTQ0nec2Sp6SUqg6D6Z93x5RZfwLl9e0SV47KovZ/G+UR3jd12xEUV3omzzaDPHQc/JXUk3VFPxFJlSNyDV/rbtpq7a4Sf5uNMLP8nHunlf0xG+yQdGqcf77Wgzdxn+CIvTCN+mM84X4BWyQl5V7ilgWe7kwyVD5/jClsYpIAEQBlApHCPC9lA2CGOGsk7YnxLIVfOcW0Fpyoi5TxOy0RdhZ3nqKA8RtfAshNNP32B4cGnrZgNzb/RgeNWE7/ZgeNWE5x7s5Lik9nNmw/+z6Ky1Hreebytb5HKgW0U3p8qyJhgjTdYDYfgHTFxxn8a82H0AACIpSURBVHja7X1plF3XVebe+5w7vFev5klVkqpKs6x5suMROwk2EDokcZpuaBxI3OkmDQESAiTQCenVsFhMccMCegVoNziEQCYnjr2ixKFtx/IkS5ZkyZpdUqkmlUo1V73p3nP27h/n3lcly5LLTpSYxbvrSSpV3fvuvt/Z47f3eYU/HXwcqsf376AqBFVAq4BWAa0eVUCrgFYBrR5VQKuAVgGtHlVAq4BWAa0CWj2qgFYBrQJaPaqAVgGtAlo9qoBWAa0CWj2qgFYBrQJaBfTfwiFvekDF/RGRH4Cw8zcVAAERWfz5AgAieM3FpO/puQBABBAAEQThB4SpoCAAAiIsElJBQABAEIRrjOkbBFRABFBEkBCARABR5Bpj6t5aBIHc/RARr6am4tRSkADAnQ/iMH1TASpuxUVIkbUS2TIDM0Mibqo28sqXpKZ35UVyJyUm/YrVcW8tRMAWynFZ0DALIqbuRl65nIgiQgqt4chGDIaZK0K+iiSV+87/VObFlkVpC70BON2NlCJTNuCZ337wnl954O44jgABUUASU0QRFEGovAAFAS/XqMTBoSCiJC8QFAFMHaUkBkGKbMwGSh/7x5/5+IPvY4nBXSUgsMDtJNeIVjouWczApx5+/y/f/544jjEV8hI9FRAQQScwACAQOFeGgAjuBxUXLN8/QAUABQRJU6lk/Cb63Yfvfcs7tze05ghRKU1Ko3IwChCSp0jNv4BA5HLPh855oEJSmpR2J6MiSUBO1khpFZUNZPkTD/7Cj/zHG+rbahWRVsrdFMU9sMNWRFBrKhbjTJv/6Uc+sPPHN9e15hBAKY+UQjWvpwIAKABISKQVEgqLjdlE1sbWGYFSikgtxgHr16eaKCCoteQLUXN37e987f1rtq8AgDOHh8dluq5krWUPVegHAGgsF0sFAMBUCTIq4yniFCRwT+QQQMiXCiycLhpqpIwXSBpGlFbFQqm2LfjtB9+/8ZZ1ANB3ZPhiNFWraqy1Gr3A91AweVdB5al8vti8ou5TD927cnMXAJw5ODgB06bEbNlDL/B890QoAIQKqVSKIikrUJlskKsNlNLWcJQvF/KFGFiDDoOQFLJlxCuihIsaCZcksoIgeZTPFzs3NH3q6x9ctqbDxFZ76uL58YPfOgagggw9/42jz/zTcVLU2lP3zo/dhFq7S63wI3/27OiJcR1qYBchKr4O4pL50Q/v3HTLysJc2RoOa4IXHz255/MveaEWBq1prlBo6an/3Yc+uGLL8jiKPN+fvji199tHIYYwq1/8zsuP3X/ACz0QEQHl6bl8vntL+ye/dm/HynYbW+Wp0aHRQ4+eRFR+Rj3z4It7v3QiCANmIYUmNkVTXr625S3v3rT5trUdaxtrGmq01jbmwkzx4sDE6f0DB3YfPf50v40xDDyn3fhquOpFogmAIqA9ms4X1t3Y+d+/+v6WzjZrrPaUiLQsabrrA7dZw0qT54dP/dOR2ML179n4k//t7dZYUiQspOjYd/sGT1zwyWNO3AcIAIGNuaYl+JlPvqOpvV5YWEQpau5oePzzh31A5eFcvrB8c+unvn5vx8oOa6zneyJQ11J/1z23WMtKUUNrw7/cf8D5ReXRXD6//pZlv/PVDzS1N1tjladEpLWz9a4PtFljlVaI6qkvvRRioBXki+Xmztx/+fS77rhnZ5jNiAhixa6gob2uY3Xblreuf+9v3XnsmdNf+J3dJ/YMKl+B4Bs0eXGGBEJKTefntt+15hNffH9tQ84aVlq52wuDtZYNK02nn++3gAS45vouALDGOosul8r9L573QAsn4cktFSFFNl61rqOhPWtig4jWsFJ0al+/Aas8PTU7vfHWrt/+8r1NSxqNMVprEXH5kjVsjVWKTu3ri8GEFCDgTH7uhp9Y/5v//PM1dTm2lwspSsOpvQMCoDTNzhbX39r1W//8vpalzcxijWXLiJW8VZKwBAAgG29e+/N/7H3i5r9S8j34UBc4SeFssXDT3Zt+4x9+LpOtYctKu1CCbNkVSkgEAGcODiBQptZfsbUTALSvAZAIL/SOXOybdhq9MMYhggXp2dZJ4DFapciZUu/BAQ1qZja/467Vn/jSB3L1tWytStB0N50XsvfAMAERwdxc/rb/sPnXH7gnCDNsmdTlQiIA9B0a9EEX5qLure2ffOg/1zXVmtgqTUiotBbn5ZNYiSLCVpzOPvKXT1hrfN8T5ooWv16TR9JYKJRv/9ktv/WFe2NjmJlUJZlnJCQkYUHC/HRh+OQYArcub1iyohkAEFEsA6lzh0fyhWIuk2VOhKsYDYKsuaF7weJRqVQaOnrRAN/8U+s+9dCHrGVrI6U8EXBPiISEKCJKe1G53Hd4OECvMFd8689v//UH3m/iOBXSZWqXCDkzPjd8fIyUJ2j/65+/u4ImAAjz3m++dGzPmfJs2Qt1U1fj2l3da3d1a98jwse/sPexfziUC7PCaVB9/YA6TycaYGJo7quf2X3rv9/Z3t0mLIAgDEhmz1cODx656PlKBfrc0eHp4TwDLt/Y7Pk+W0ZCAQSA3gP97AKQq1Yr0d9I6Hkrty1N0BdAhJEzY6N9UwHo6QuFL//Joze+a/PytZ3MiaUjwrMPHzyzbzgIA/JoqPfCxd5pHZIpqrHB2a995ts3//S29q72REgRJH7yiy8MHZvQvvICffbw0PRYydh410+s2Xz7OraiNAkDKfi/H//6F+97zEMtaTobou5Y2/oTv3xj16bWv/+NRwIKXIaL+MZ8qCCgsEU/CE4+c+65J19ataOrvbvNrTwSTl7M/+WHvjI5PqdRibACL5cNOS47B+qgI0IA6H1hUAFJiiZAYn9R2bSvbOhY1QIASMhWgLDv8HC+UKrL1pw5eP75vcc7VjcvX9spzKgIEUuF0md/5WvD5ybck2vAjB+wlTBQx77bt/exI6uv72rvaq8IOTYy85cfenBqKq9RsYgGVZutKcZz299xXVKbCpLCuYmZb33uuVqoydZmGFhERISNDJ+8+Ne/+nWNpLSnPXKZ6Rv1oZikNQKiQa/oXNK1oSNVJUHAoeMX44m4OVcvnJZQLBqwZ8dyd6GDbXZyZvj4qEdaRGQhV0EUg126sSVTk2Hrim4BgN79QwIiCBp0V+OSVduWAQgSCQsqHDx1cW6k3FLTUKllrWXnLjSqnq6Oro2XCDl49EI0ZVtq69kmQjJbD4LuTR2JkAjCUtOUfdeHb3v4T56emJlmYA+0R54OVDYXsoBYERC5KpqLTOwRBFBhqRytXt3Z1F4vzIAoDE7vymJ8FjZWEBDRxtzQmuva2HbJI528ODlU0IHnyoMF1TkK8JpdyxNNASQiAD67f0iBRoAoijuva2nramawiNoyE0DfoaFiuayVEsuSMl0AgERROV6yenl9c13FKQHAy/sHylAOrc82DS5ApCCoVZdUa4z3fPpdP/bBW196vPfk3r7+IxfOnxwbH5kxwBkdeJ5i69CUVw1Hry8PJSQDcdfWDgDFbEhpRHGyQlKbJLlubM2SNR0tS+pEGJCEGQDOHhoqSVxHgbWMFYEQRIQAVu5ansAsgIST4zODpy746ANIBLZna7tSnjVMKtHfU/v6HAYMiCIAmAQ5RAN25Y4OAGK2pMgp08svDJAT0hkbIBHE1o72Tq/bCcJCCbDELC1Lm+74uaa3/twNgmZ6bK73xfOHv33ysc/tn7lQCMOQ2V4dU3pNNF2dCwIAtOb65ZVUihRZE587ckGDEpaU3QADZsX2ZQBeal8IAKf3DSZ160InCmBjrmuo6d60BACAEi5u+Pjo5Pm89hEEBXjlrqUV4kcpFIj7Dg1pUCKCLsVFZ/kIAgi4aueyyn1JURzF/UdGffBSp5SwMQT42APPAwAqMLF10rp0lS0bY5ixoaV+x1vXf+CP333f/o+uurGzWCq5zEGurKH0mubu/jLMWS9cta3imwAARvrGR86O+dq/lO2gNbuWVRZEaWLgvhcHNWhHQmFKhCGBMaZ1ZWPTsgYGrpCbZw8OR2BRg2UJUK/a2eVuCgKIauL8zPlT477SlXw2LYyFjanJhCu2LnXxzZ0wcmZ87Nyk5+mkq+A4JSuZMHvgm6f/5mNfjk2kPeXyU7aJl1RaESphEBYT29ZlzR/73H+qbQlsZJEQr0xELoJtEgQELpuWnlzH6o5EVmZHTxTmyspLTQCBjWQ8vWLH0kpEAoDRgfGLZ6Z8rYUdwYauaUJIEZhV1y/1yBczz4ud3HfOkWYmMk1LajvXtlbcMQD0HxuZHisoT1XcMbpiDjGOpbW7fsnK9lTXBAB6XzxXKJZJq0Q1nMGBCHMY+A/f99RHttz3z7/3zbOHzxljlCZSSIpAhK1FQlSoPWUis3RN503v3Vq0ZUWOhnyjpSegEFEMZvmGjjATsGWihErs3T9oHQ/pUnLEuMzNK3IdK5tdiBAWBJy9mC/ORkrptJpLKk9gUgC3/+zORAFBSGEcl84dPu8DAYhh03Fda2PLJWHwzIEBA4yEbg1SgAAJY4i7N3cEgc+WiSgVcohTITEpzUSc20WoydSMnJ783O/u/vLvP75sXcuqtyxbc/3y5ZvaV25dnq3JiqT1EiEAdG1oF3AFEl/Jhy4isRcAQAt21fWdiScDICIA6X1hIPVlLrtCBtOyvCGbq3Ha5GJCbVPWyyiOnBkCApBCABorTNz94R/Zcvs6ZnE/IqLz/ZOjZyY97QmgAbtqx1IAcJyQe7fT+4cUKHCkZ6KeDlXk1OG65IyIAMyZg0MKdOpwXfREQCAEG1vyMQj9AHw2fO7I6OkjQ9/6P3t91EvXNN/7F+/cedcWtknFBQAmjqXSsLhCXFqEybsKD9SqnZ0Vr0qE5ciMnJn0QCOhYxAQwALXNtUCJOYGiNaYJT0tN7xn01h5ykTGRtaUzFyhOFfIv+eXbvvgZ94tktCL7pJzR8/PzRaUR07tKxHJ6SAAjPROEmhERCRygc4JacUDtXJHZ6rvQISlYnzh7JQHmggQKTF2EEKMjPXr/blioVSIhEV5lKkJ6nO19bnabE3m3Kmxz/7qV+OoSGo+CA2fGndUvlw5yi+KYLaxrWvIdG9cCgAuE2HLge9tftuKh08/ZYsZYNGayA8AgI1dGM5QKQD8xb94T12Lv//h06W5OMj5K7a03/mLb9l55yZHOizstb28f4gBgJAjWxNmVmxe5ryHQxwVbrmj++QL56RokVkpX2tyJmliW9uSq6T0Tq/DTGbT7ct3n3neFANiIK21UqRwujD39vft+NCfv/c7f//co599dujUuAFQoJXDi7gI5TU7uj0/49pQpKlUKp18+twl2cKrqt/VCWYBIIRyySxb3/yZgx8NQr/SaxTkuBSdeOZsaS7KNYf3f+SRs/svCEDPttY/3f8xrUgSHUURYWalVKlcLs2Ww5ogzAQiYq1VSlXQFAEi/B/v+N8v7D5VU5OJ83Hj8ro/P/KbNfUZl6W7d4ui6NRzZ2cnSvXtmQc+vvvEnnNhJgCRcinu3tz2pwc+6mm/whIBcrkYHX/2TLlgco3h33z4ocEXL1rhrh1Nf/T4R7J1NQBQLBSO7jl9+Dun+4+MTl8osrXZpnDTHT0/9ZE7ahvrRISNVZ5++msH/vDuB7KZ7JV4pkVp6Px1akFYcz5dyA/CrW/b4Hjl7g0vnNw/UJvJDp242H/s/MrNy5itUo6LRCSylgPfD1sCEIjLhjQ6ZrPS8yLC/Mzc0LExja5ChTSFZlceIoKIeNrb9CPr3E1Xbj58ZE9vBkNJfQIDiHCSOCOAUBCG29+20Z3ftb719KHBto66j/7d+7J1NcYYBAwzmV0/tnXnXVsQkZlFRCmVuCABa432aG567gufflSBN+9C32AeCiICnqfGzk2NnZsCIGt4YePPGjZxDABxZABAaSqWom/+1R4AYGvZclpTAhG6nI6ZvUBf6BsbOHkeEa0RYbGGAWD41MWJwRnP12JB+3pyeGb45VEAsrEB4MQtIFhjTWzd3ZMeEoPW6kLf1ET/FKITMs0UxQlpAIAFYjBd17Wv3LJcBMgZeMorV/pxnMppLWvtlYvRfb/w+b4jF8KMx/YqSf2iAHWcI83Nlb/8B7sdZJdcr1D7HgAIWgCwVrJh5jt/s2/33+7xfD8J82kij4TaU3EcffOzT/zals989pe/6NQKE04Zel8cKdqYFAEIKiyb+Et/8CiD0Z63wG8hKdIeuZg3TzD6ana6+JU//BYAKEULgyop9HwNAFGZMxAc2zPwe+/823PHB0gjKURCUoREwMJWrGEEUB4RkdJ05lDfJ9/+F88/dKI2k7FW8LVmOdRGfetV1TMxNN/Tp18Y7D080NpTX99co/3EV0TFeHRg/Kmv7H/igQNcACQAAUV67yMvTY5Mt61qqG3KKSIktMYMnr7w+AN7//qXHnz07/ZJTETYvbU1P12aGJ6ZvDAzPT79yJ/tudA75WkCRhHxPe/skfMnn+tt6amrb8lpz0vcaDm+2D/x7DcO/b/798XTggpcTevr4MTz/eeO9bf21NU312pPzQvZP/7kl/bu+ceDtghaq75j5594YF/f4UFGk6kNwtpAKQWYri5BYar40jOnvvg/v3X/x74xenamJpO11ia9pqtq6Gt2PZOJBSKLoPKlImlY0t1U35olrcolLk6WJs9PzxZKGR2qNF9z+U2+VMpmMktW19e35ZBhcnTm4tnp2UIxQB2EoYgYY6xlhZSOcgkQeq7JkTbribBQKoHCjuWNDe1ZCtAUOT8VTwxPz+ULgQ504qaTmpJQFUpFraGtu7G+LUMelQtSnChNnJ+dKxYzXqiIRIS04pgLcRFB6urrWroyjUvqw8acH3pRPpoZnRk9M3lxeMqKZP1M2jrGq7FMiwA0UU9rhdAW4zD0OPTYWCiX2YIVEAJQQMrTyiPXtMGKjSOQIo5tFMcWAIAVKM/ztQfMwq69g5cOJ7nqiRdSZCICSilhjiLD6YyfAqU9Up5i5ksISgFBUaSYIS7HFjgVUilPXSKkiHMFIGTi2Bo2YBgAgBGQADV6XuAhiQsDSY2XDEi9MfpOgIjzJf/OHYfuvvHAN57b/OTxDROFuqwfhVkU0K4+ckMibK1LJ9PqXxDQWouEQeg7OgQERNjYpO50GnhZUVaRtVJ8gWWLAH6gIe3uikBy01ewvcl9GVH8UAGq9HwBgYVCuuusZQQmRUqrAL0FjRk3AmSAAQFZkIWsJa0sESdp/hVgvZoPRURmagiLP7r98C2bTmzr6ffRDE3WTRWyKKhIQBgSVUtplETRkpmQdFWTghUlmRNKEH0V6vvy7yXMh7hWhQCwpHN1lyuL42TdMqcTSwLpWMGC0YrK2W40ihgEgEUYjFHlWJdiVTZeZJQR1mRqM/kljROx0cZ4SAvoiNflQ0WASPIlb03n8K/91O6e9pGygeHx9j2HNzx5fO35yTaNEPgRIYsjkOa1BBaUuqnaCQC+pgu6CqWQxlfEVEcWcVUqCsjlN0/Sf8tUin0AUGhDr5wLS/XZmcb6Ynv9VFv9dFv9dHNtvjZTXNI09dVnbnrgsbfWhiXrBtpeL6AOU0VcKAdNdRMffse/7Fh5qmQo8HhyLvv8qQ1PvrTu9PmOUpwJVOxpwRTZRH6Redf4pjuSATzLqjYzd9PaU22Nk6310y210/W1+VxQDD2jVIKAYTCxyvjyv77x7544srUmLFmhKznSq6dNgCgsFHgmX6556sSqwJPrlo4WjdUq3rB8+JaNJzf3DOSCwkwxM5XPRrHvSDvChClzo4Dz7ExFTypfLyZwXq52lxZzb+w9EBBJipG3fcXAR37moTUdQ51N4425uUBFAhxbKMcQGYwMGoue5uHx9geeuN11cB0d8wby0AQAFtDEBPq50ytGp+q29IzkgvJ0wUcwHY2Tu9acufW6Y2uXD9X4pUJZzRQyhdhjqwhJocWE03XkLlQIN8c/p773NXxB0t+oTMth2plLWM2U334d2CZ39LQ9P1k3NlG3eslYoEqlSElKXBMCEhCCCGQD2H1g+76X12S8mAGvYnSvpaGVQVhBRAk9OTHcceDl7mXNUys6xmNDZQORAc8zPW3j16/vvXnjqS0rzrXVTyNKsUxzpUzZBMYql5sSCc2P1EIFZbyK/1sQQ9zJBIAIlL5YaJ40XqyPdoFO0pVURwc6j57tXNo23dYwwyn7nFoVEEEpDj732B35Uo0iWSjR6wY0dYGV0ImhZ6bydXuOrS3G3sZlI5kwjo0SAGMojsnzy0tbJretPnfLpqM3bzx13Yr+zsaxjB8xSznyimUXOj1jiQUACIWSGWEEckmAexEQJrshKvmYCDLr2HomVmWjSkYbA54uIRlmTXSVeY5L16nCSIMAgiLOetw31b7v9NK3bzoV+iWRFEwEEcoGcqB39e59u0KPGdJLX3ceepmjctHVMgVeLKK++tStR3p77nnbnu0r+opGjEFFzALFMjAAkm1pmOxonrht44nIqplSzfh0w4WJuqHxxgsTufHpxqnZzGwpG5WDyHjWIgMygABVaCL3UAiAwAqElPjaZDPFbE2+vq7QUj/T3jzZ2Ty7vH1sei533+d/Mo5DIn4VKkgWQOmaeQgoSMhIYFgVylqR3d51+sd3HqoJirF12VjSE2MAFr3n2FojvmARhORK7aTXA2jSA0YUQGAmRMmFce+FZb//xffeuf3F9970bGvDbL6kmVkREwIgxAbKhtwEfCacWZmbWdMNiMACxmKpHOSjIF/yC8VMvpwtlrxiOYiMYpHYakDWJEpJ4MVhYMJMVBMWwmypJlvKBVHWj5QSQgALQDA40pK0tS6zRYFKtpH865yjAJSNjizWZWZv2TB4x5ZjW7v6fa9YjDH0AQ1FlkBYgAOP+0fbX+xdlfGidIryannL4kfCE9N3OxME0LKEXgyiHtl34/7TK9970/7bth3NecViBCxEyIii3AIAsIUyI8fONTGReH6pKSw1N4AiIALBJAhYTJ/ZFQcE1n3BYASYARkiBolRGIShNiu9A0tmC7lsGFe2g2BlPiXtOyEyEohgZHRklU9Rd9voDWtfvvG6kz0tY4hmpuSLoVDR3//LLbHx7r3zu3FMDOxr2HNi3UyprjYsMrvRg+9xcuQVQSpdbUFkAUCuDYuTc41/tfvOx15af/fNz+9ceyZQtlTWDIzIyWqSAIoCFGA3S8QMLMgWBNOAj0mBg4iIwABC6cCr28YzzwMCKiAEi0IE/SMtDIgozJQ4SLePBIFAANAIxFFoBDwqtTdf3Npzbtf6M+uWDtaHpbKBuYiEg1ymPDHddN/utz97el2gordtObGy7XyZaXouu/fYWl8ZN3mG8BoVxesEdEHW4eZAUNAKeMr6Gk8Pdf/Rl5duXdn3zpte2LZiAJQpRciCQgucDi4omlASZSQAEALgdIdcEgbR5RjJthFKtyRJ2hVGhNhi/3Cby8GJuMLNWKsiizETgtQE5e6l/eu7+7etHFjVeb6uJo8MxQhniq51zbls+YXe1X+9+0eHJ1oas6WpQubpY+tWLxkMiZ44uWpovC0bRPaK5fv3BVAHTeKfUUQYIPRjADnYu/rImZ4tq/p+/PoDW1f31Xhx0WAk6NIdvILWL5RVAASRk6CPleAtIojkBsDcuVrB9GzN0GizVhIbbYy2ggJCaHOZwtLWyZ6O0bVdo2uXjixpGgvCSCzEEeSLmE4UQuhzxOEXHn/LV569nsXPhVFsKVRm76nVd9+8tzGb/+7hjZDsUFpUTvY9AAqVFDJtiQkAUjaIQOjg6bUHeldsWD70tu2Hd113pqFuNrIQxSSslLKvWf4sZj+mCCiCfMmfyWukqD6Xb8jNtTdPLmub6mobWdY23VI3kwlKiGAMRDHMFYgACJgIxAIi1Gbh9FDn/d+543DfipzPSLGbr9eeGZ5seurEuvbaueMDS0PfiCyODV3stprF5MouGiToAiGLUCnSLNTZcv7Gjadu3nimq3PE1zYyEltgQKLUoikpeJzJAyKjSLpZoMKZVlYNBEgA3UioBP3DrQS2ub5Yk5kLPOOivzFgLBiLIArRAAAwIAAwiqVsxpbL4SN7t3/96RuLpWw2jKxQZfNQMlwPDICcTEkttmjAa/CrK+YLdbescazLlnJ+cV334A0bX966+syS5klSEFsoWQJkomTSMJnyQxCqzHw6TN0kLlc2jRIAMggAMQUaRNgwsAVmECESoaQLAAAEwCAgTMIQaPYVHurt+cJjtxwf6KnxjCKbzn2mG14SYrCSEuNi9fPaADq/g1FS8pOQLatyrFmgMTe7rnto29qz160c7GyZFowiZnK5AAAjMAJhsiuUcT5Vd+9KAm5sUUQcssIV5hCSgX5OR0QEEIiFLaOvVM4350Zav/bUridf3GzZywQRuz2lDr8Ft7oU09fBEuC1/eUqlUnDxJQFAY3FKFYMUJ/Jd7SP3/OO767rGSjHgAQEIKmSunBvcSGxCiiQTI2n/CvC/NfC6XidVABFZtKKM55MzNR9+/lt3967dSJfX+tbIcOchsnLFVDSbDatUxf5xBqu6YHJXsp03VFQiCQbGgCJJTzYt/r2kZc2rxooR8m+cBdOkznflFSiFDSHl6ScNaVZFCAQJ10CtyIswAyeglxoJ6brv/Xs+m8/v314ojX04tqwzIKysH1wOV6YRtzFUdk/KEDhFWRSsu42pUibg7lVy0Zjk9rV/Hg3LLRB9z9a0CCqsHaJ801JNxSwTAiY0VYrGJls+OZTG77zwsbB8baM4tqwzMkJKZH2/Wa/rz2gl6972pszRrU2TLU2TsY2iUYV2CkNbUKycDUqgYLSxKrCXAuD63RlQgH2+84vefLg+qePrLkw1RJoWxdGLGAdl5nul78WvYQfMKAOA8cHirHU2TZZF5ZLJpmQqKAzr9dy+ZrMf1sEWBAtKRQ/ZA9laiZz8NiqJw+vP/zystlSLqNNbVgSIcuJW5Z5I74mnZkfBqBJpxQsUPeSi57iUoTzrD7M234FufnGe/rBMcwIKFpBRokimy9mj51pf+HoqgMnuocutlrxM36UaqVCrPT65Vp3uH4ogDqzRwKzouOi+8wBTLcCzpPzC6ol10B2pyhCX4unBRgm85mTQ+1HTq84dKp74EJryYQBccY3gEUWfIWBww+kWfhDARQAgJlqwtKylonYJskzJLMQiUbaJHMSRaBItAIiYMa5YnbwQsPZwfajZ5e+3L90dKI+tr5H7HumTpdEwAKCEC5sHF8zA39zACqABFFMS5dMtzZOWUOUdD6ECFGJQgGVbOyKrCqV/bHZmpGJhv7zLX3DHQMjzaMT9YUoFKBAWV9z6JWd/lqe39y++AbTv3pAJdlaiWEQgyLDSlhxrMpGl2M/XwrzxWBqrnZiNjs2mRubqLs4XT8xW1MoZiNBBaSJPW1zYQQAnHz4BkD6OU4Ar9FEu+bu7If0aygT9qGtcUYrY6yKLUZGlWMvjnVstGHlaiIC0SRKs0JOmhjzsxSXVA1vknGKH44PTfk+GhxrTkeUoNJhDjwJ0VRIlvmPoUrIqEQVFzGs+W8G0JQ1lkAbuOxjvtJhsAWEc6qBrrZ5M472/HABTUMGzu9ZeEXr61XGHOBNqZFvFkBfFSy4wn/+NR3VT7itAloFtApo9agCWgW0Cmj1qAJaBbQKaPWoAloFtApoFdDqUQW0CmgV0OpRBbQKaBXQ6vFax/8Hq2rCqnGXXpAAAAAVdEVYdHBkZjpBdXRob3IAU3VwZXJ2aXNvcq7E1dIAAACjelRYdHhtcDpDcmVhdG9yVG9vbAAACJklizsOwkAMBa/iElqgoNkihI+QVoCCggSdia2wfLyJs+E+QMFB9mIkohpp5r0U5YkwyFiIlXUI5AszT1aLOnfahAm0DavJk+V0Y/ej0/gIZ0UhM+tNSpe8LCHwo7pjYLPzTYAKFcE6uTGtBYghVYfxGz8esviqHPW1bjv+5VbL+BZXeDiwdnPb/eWKPy8QOQUV5AGlAAAAAElFTkSuQmCC",
            alt: "Logo Tutts",
            className: "w-28 h-28 mx-auto mb-4 rounded-xl shadow-lg object-cover"
        }), React.createElement("h1", {
            className: "text-2xl font-bold text-gray-800"
        }, "Central do Entregador Tutts"), React.createElement("p", {
            className: "text-gray-500 text-sm"
        }, "Solicitações e Saque Emergencial")), "register" === p.view ? React.createElement("div", {
            className: "space-y-4"
        }, ue && React.createElement("div", {
            className: "bg-blue-50 border border-blue-200 rounded-lg p-3 text-center"
        }, React.createElement("p", {
            className: "text-blue-700 text-sm"
        }, "📊 Carregando lista de profissionais...")), be && React.createElement("div", {
            className: "bg-red-50 border border-red-200 rounded-lg p-3 text-center"
        }, React.createElement("p", {
            className: "text-red-700 text-sm"
        }, "❌ ", be), React.createElement("button", {
            onClick: Ta,
            className: "text-red-600 text-xs underline mt-1"
        }, "Tentar novamente")), React.createElement("div", null, React.createElement("label", {
            className: "block text-sm font-medium text-gray-700 mb-1"
        }, "Código Profissional"), React.createElement("input", {
            type: "text",
            placeholder: "Digite seu código",
            value: p.cod || "",
            onChange: e => x({
                ...p,
                cod: e.target.value
            }),
            className: "w-full px-4 py-3 border rounded-lg " + (p.cod && !ue ? p.codValido ? "border-green-500 bg-green-50" : "border-red-500 bg-red-50" : "")
        }), p.cod && !ue && !p.codValido && React.createElement("p", {
            className: "text-red-600 text-sm mt-1"
        }, "❌ Código não encontrado na base"), p.cod && p.codValido && React.createElement("p", {
            className: "text-green-600 text-sm mt-1"
        }, "✅ Código válido!")), React.createElement("div", null, React.createElement("label", {
            className: "block text-sm font-medium text-gray-700 mb-1"
        }, "Nome Completo"), React.createElement("input", {
            type: "text",
            placeholder: p.codValido ? "Nome carregado automaticamente" : "Digite o código primeiro",
            value: p.name || "",
            readOnly: !0,
            className: "w-full px-4 py-3 border rounded-lg bg-gray-100 cursor-not-allowed " + (p.name ? "border-green-500 bg-green-50" : "")
        }), p.name && React.createElement("p", {
            className: "text-green-600 text-xs mt-1"
        }, "🔒 Nome vinculado ao código")), React.createElement("div", null, React.createElement("label", {
            className: "block text-sm font-medium text-gray-700 mb-1"
        }, "Senha"), React.createElement("input", {
            type: "password",
            placeholder: "Crie sua senha",
            value: p.password || "",
            onChange: e => x({
                ...p,
                password: e.target.value
            }),
            className: "w-full px-4 py-3 border rounded-lg",
            disabled: !p.codValido
        })), React.createElement("div", null, React.createElement("label", {
            className: "block text-sm font-medium text-gray-700 mb-1"
        }, "Confirmar Senha"), React.createElement("input", {
            type: "password",
            placeholder: "Digite a senha novamente",
            value: p.confirmPassword || "",
            onChange: e => x({
                ...p,
                confirmPassword: e.target.value
            }),
            className: "w-full px-4 py-3 border rounded-lg " + (p.confirmPassword ? p.password === p.confirmPassword ? "border-green-500 bg-green-50" : "border-red-500 bg-red-50" : ""),
            disabled: !p.codValido || !p.password
        }), p.confirmPassword && p.password !== p.confirmPassword && React.createElement("p", {
            className: "text-red-600 text-sm mt-1"
        }, "❌ As senhas não coincidem"), p.confirmPassword && p.password === p.confirmPassword && React.createElement("p", {
            className: "text-green-600 text-sm mt-1"
        }, "✅ Senhas conferem!")), React.createElement("button", {
            onClick: Ul,
            disabled: c || !p.codValido || !p.password || !p.confirmPassword || p.password !== p.confirmPassword,
            className: "w-full bg-purple-900 text-white py-3 rounded-lg font-semibold hover:bg-purple-800 disabled:opacity-50 disabled:cursor-not-allowed"
        }, c ? "Aguarde..." : "Criar Conta"), React.createElement("button", {
            onClick: () => x({
                view: "login"
            }),
            className: "w-full text-purple-700 text-sm"
        }, "← Voltar")) : "recuperar" === p.view ? React.createElement("div", {
            className: "space-y-4"
        }, React.createElement("div", {
            className: "bg-purple-50 border border-purple-200 rounded-lg p-6 text-center"
        }, React.createElement("p", {
            className: "text-5xl mb-4"
        }, "🔐"), React.createElement("h2", {
            className: "text-xl font-bold text-purple-800 mb-2"
        }, "Esqueceu sua senha?"), React.createElement("p", {
            className: "text-gray-600 mb-4"
        }, "Entre em contato com o suporte Tutts para obter uma nova senha."), React.createElement("div", {
            className: "bg-white rounded-lg p-4 border border-purple-300"
        }, React.createElement("p", {
            className: "text-sm text-gray-500 mb-1"
        }, "📞 Contato Suporte"), React.createElement("a", {
            href: "https://wa.me/5571989260372",
            target: "_blank",
            className: "text-2xl font-bold text-green-600 hover:text-green-700"
        }, "(71) 98926-0372"), React.createElement("p", {
            className: "text-xs text-gray-400 mt-2"
        }, "Clique para abrir o WhatsApp"))), React.createElement("button", {
            onClick: () => x({
                view: "login"
            }),
            className: "w-full bg-purple-900 text-white py-3 rounded-lg font-semibold hover:bg-purple-800"
        }, "← Voltar ao Login")) : React.createElement("div", {
            className: "space-y-4"
        }, React.createElement("input", {
            type: "text",
            placeholder: "Código Profissional",
            value: p.cod || "",
            onChange: e => x({
                ...p,
                cod: e.target.value
            }),
            className: "w-full px-4 py-3 border rounded-lg"
        }), React.createElement("input", {
            type: "password",
            placeholder: "Senha",
            value: p.password || "",
            onChange: e => x({
                ...p,
                password: e.target.value
            }),
            onKeyDown: e => "Enter" === e.key && ql(),
            className: "w-full px-4 py-3 border rounded-lg"
        }), React.createElement("button", {
            onClick: ql,
            disabled: c,
            className: "w-full bg-purple-900 text-white py-3 rounded-lg font-semibold hover:bg-purple-800 disabled:opacity-50"
        }, c ? "Entrando..." : "Entrar"), React.createElement("div", {
            className: "flex justify-between text-sm"
        }, React.createElement("button", {
            onClick: () => x({
                view: "register"
            }),
            className: "text-purple-700 hover:underline"
        }, "Criar nova conta"), React.createElement("button", {
            onClick: () => x({
                view: "recuperar"
            }),
            className: "text-gray-500 hover:underline"
        }, "Esqueci minha senha")))));
        if ("user" === l.role) return React.createElement("div", {
            className: "min-h-screen bg-gray-50"
        }, i && React.createElement(Toast, i), n && React.createElement(LoadingOverlay, null), u && React.createElement(ImageModal, {
            imageUrl: u,
            onClose: () => g(null)
        }), React.createElement("nav", {
            className: "bg-gradient-to-r from-purple-800 to-purple-900 shadow-lg"
        }, React.createElement("div", {
            className: "max-w-7xl mx-auto px-4 py-4 flex justify-between items-center"
        }, React.createElement("div", null, React.createElement("h1", {
            className: "text-xl font-bold text-white"
        }, "Central do Entregador Tutts"), React.createElement("p", {
            className: "text-sm text-purple-200"
        }, l.fullName)), React.createElement("div", {
            className: "flex gap-2"
        }, p.userTab && React.createElement("button", {
            onClick: () => x({
                ...p,
                userTab: null
            }),
            className: "px-4 py-2 bg-white/20 text-white rounded-lg hover:bg-white/30 text-sm font-semibold"
        }, "🏠 Menu"), React.createElement("button", {
            onClick: ul,
            className: "px-4 py-2 bg-white/20 text-white rounded-lg hover:bg-white/30 text-sm font-semibold"
        }, "🔄"), React.createElement("button", {
            onClick: () => o(null),
            className: "px-4 py-2 bg-white/10 text-white hover:bg-white/20 rounded-lg"
        }, "Sair")))), !p.userTab && React.createElement("div", {
            className: "max-w-2xl mx-auto p-6"
        }, React.createElement("div", {
            className: "text-center mb-8"
        }, React.createElement("h2", {
            className: "text-2xl font-bold text-gray-800"
        }, "Olá, ", l.fullName?.split(" ")[0], "! 👋"), React.createElement("p", {
            className: "text-gray-600 mt-1"
        }, "O que você precisa fazer hoje?")), React.createElement("div", {
            className: "space-y-4"
        }, React.createElement("button", {
            onClick: () => x({
                ...p,
                userTab: "solicitacoes"
            }),
            className: "w-full bg-white rounded-2xl shadow-lg p-6 flex items-center gap-4 hover:shadow-xl transition-all hover:scale-[1.02] border-l-4 border-purple-600"
        }, React.createElement("div", {
            className: "w-16 h-16 bg-purple-100 rounded-xl flex items-center justify-center text-3xl"
        }, "📋"), React.createElement("div", {
            className: "text-left flex-1"
        }, React.createElement("h3", {
            className: "text-lg font-bold text-gray-800"
        }, "Solicitar Ajuste"), React.createElement("p", {
            className: "text-sm text-gray-500"
        }, "Retornos e Pedágios")), React.createElement("span", {
            className: "text-purple-400 text-2xl"
        }, "›")), React.createElement("button", {
            onClick: () => x({
                ...p,
                userTab: "saque"
            }),
            className: "w-full bg-white rounded-2xl shadow-lg p-6 flex items-center gap-4 hover:shadow-xl transition-all hover:scale-[1.02] border-l-4 border-green-600"
        }, React.createElement("div", {
            className: "w-16 h-16 bg-green-100 rounded-xl flex items-center justify-center text-3xl"
        }, "💰"), React.createElement("div", {
            className: "text-left flex-1"
        }, React.createElement("h3", {
            className: "text-lg font-bold text-gray-800"
        }, "Saque Emergencial"), React.createElement("p", {
            className: "text-sm text-gray-500"
        }, "Solicitar adiantamento")), React.createElement("span", {
            className: "text-green-400 text-2xl"
        }, "›")), React.createElement("button", {
            onClick: () => x({
                ...p,
                userTab: "indicacoes"
            }),
            className: "w-full bg-white rounded-2xl shadow-lg p-6 flex items-center gap-4 hover:shadow-xl transition-all hover:scale-[1.02] border-l-4 border-blue-600"
        }, React.createElement("div", {
            className: "w-16 h-16 bg-blue-100 rounded-xl flex items-center justify-center text-3xl"
        }, "👥"), React.createElement("div", {
            className: "text-left flex-1"
        }, React.createElement("h3", {
            className: "text-lg font-bold text-gray-800"
        }, "Promoção de Indicação"), React.createElement("p", {
            className: "text-sm text-gray-500"
        }, "Indique amigos e ganhe bônus"), ee.length > 0 && React.createElement("span", {
            className: "inline-block mt-1 px-2 py-0.5 bg-blue-500 text-white text-xs rounded-full"
        }, ee.length, " promoção(ões) ativa(s)")), React.createElement("span", {
            className: "text-blue-400 text-2xl"
        }, "›")), React.createElement("button", {
            onClick: () => x({
                ...p,
                userTab: "seguro-iza"
            }),
            className: "w-full bg-white rounded-2xl shadow-lg p-6 flex items-center gap-4 hover:shadow-xl transition-all hover:scale-[1.02] border-l-4 border-cyan-500"
        }, React.createElement("div", {
            className: "w-16 h-16 bg-cyan-100 rounded-xl flex items-center justify-center text-3xl"
        }, "🛡️"), React.createElement("div", {
            className: "text-left flex-1"
        }, React.createElement("h3", {
            className: "text-lg font-bold text-gray-800"
        }, "Seguro de Vida - IZA"), React.createElement("p", {
            className: "text-sm text-gray-500"
        }, "Coberturas, valores e como acionar")), React.createElement("span", {
            className: "text-cyan-400 text-2xl"
        }, "›")), React.createElement("button", {
            onClick: () => {
                ot(!0), st(0), Ga(), Za(), x({
                    ...p,
                    userTab: "loja"
                })
            },
            className: "w-full bg-gradient-to-r from-purple-500 to-pink-500 rounded-2xl shadow-lg p-6 flex items-center gap-4 hover:shadow-xl transition-all hover:scale-[1.02]"
        }, React.createElement("div", {
            className: "w-16 h-16 bg-white/20 rounded-xl flex items-center justify-center text-3xl"
        }, "🛒"), React.createElement("div", {
            className: "text-left flex-1"
        }, React.createElement("h3", {
            className: "text-lg font-bold text-white"
        }, "Lojinha Tutts"), React.createElement("p", {
            className: "text-sm text-white/80"
        }, "Ofertas exclusivas com abatimento no saldo!")), React.createElement("span", {
            className: "text-white/60 text-2xl"
        }, "›")), (() => {
            if (!l || !l.codProfissional) return !1;
            if (parseInt(l.codProfissional.replace(/\D/g, "")) < 14e3) return !1;
            if (l.createdAt) {
                const e = new Date(l.createdAt),
                    t = new Date;
                if (Math.floor((t - e) / 864e5) > 30) return !1
            }
            return !0
        })() && React.createElement("button", {
            onClick: () => x({
                ...p,
                userTab: "promo-novatos"
            }),
            className: "w-full bg-white rounded-2xl shadow-lg p-6 flex items-center gap-4 hover:shadow-xl transition-all hover:scale-[1.02] border-l-4 border-orange-500"
        }, React.createElement("div", {
            className: "w-16 h-16 bg-orange-100 rounded-xl flex items-center justify-center text-3xl"
        }, "🚀"), React.createElement("div", {
            className: "text-left flex-1"
        }, React.createElement("h3", {
            className: "text-lg font-bold text-gray-800"
        }, "Promoções Novatos"), React.createElement("p", {
            className: "text-sm text-gray-500"
        }, "Promoções especiais para novos profissionais"), React.createElement("div", {
            className: "flex gap-2 mt-1 flex-wrap"
        }, ce.length > 0 && React.createElement("span", {
            className: "inline-block px-2 py-0.5 bg-orange-500 text-white text-xs rounded-full"
        }, ce.length, " promoção(ões)"), React.createElement("span", {
            className: "inline-block px-2 py-0.5 bg-red-100 text-red-700 text-xs rounded-full font-semibold"
        }, "⏰ ", (() => {
            if (!l || !l.createdAt) return 0;
            const e = new Date(l.createdAt),
                t = new Date,
                a = Math.floor((t - e) / 864e5);
            return Math.max(0, 30 - a)
        })(), " dias restantes"))), React.createElement("span", {
            className: "text-orange-400 text-2xl"
        }, "›"))), React.createElement("div", {
            className: "mt-8 grid grid-cols-3 gap-4"
        }, React.createElement("div", {
            className: "bg-white rounded-xl p-4 text-center shadow"
        }, React.createElement("p", {
            className: "text-2xl font-bold text-purple-600"
        }, j.filter(e => "pendente" === e.status).length), React.createElement("p", {
            className: "text-xs text-gray-500"
        }, "Ajustes Pendentes")), React.createElement("div", {
            className: "bg-white rounded-xl p-4 text-center shadow"
        }, React.createElement("p", {
            className: "text-2xl font-bold text-green-600"
        }, M.filter(e => "aguardando_aprovacao" === e.status).length), React.createElement("p", {
            className: "text-xs text-gray-500"
        }, "Saques Pendentes")), React.createElement("div", {
            className: "bg-white rounded-xl p-4 text-center shadow"
        }, React.createElement("p", {
            className: "text-2xl font-bold text-blue-600"
        }, re.filter(e => "pendente" === e.status).length), React.createElement("p", {
            className: "text-xs text-gray-500"
        }, "Indicações Pendentes")))), p.userTab && React.createElement("div", {
            className: "max-w-4xl mx-auto p-6"
        }, React.createElement("div", {
            className: "flex items-center gap-4 mb-6"
        }, React.createElement("button", {
            onClick: () => x({
                ...p,
                userTab: null
            }),
            className: "p-2 bg-white rounded-lg shadow hover:bg-gray-50"
        }, "← Voltar"), React.createElement("h1", {
            className: "text-xl font-bold text-gray-800"
        }, "solicitacoes" === p.userTab && "📋 Solicitar Ajuste", "saque" === p.userTab && "💰 Saque Emergencial", "indicacoes" === p.userTab && "👥 Promoção de Indicação", "promo-novatos" === p.userTab && "🚀 Promoções Novatos", "seguro-iza" === p.userTab && "🛡️ Seguro de Vida - IZA", "loja" === p.userTab && "🛒 Lojinha Tutts")), "solicitacoes" === p.userTab && React.createElement(React.Fragment, null, React.createElement("div", {
            className: "bg-white rounded-xl shadow p-6 mb-6"
        }, React.createElement("h2", {
            className: "text-lg font-semibold mb-4"
        }, "📝 Enviar OS"), React.createElement("div", {
            className: "space-y-4"
        }, React.createElement("input", {
            type: "text",
            placeholder: "Número da OS",
            value: p.os || "",
            onChange: e => x({
                ...p,
                os: e.target.value
            }),
            className: "w-full px-4 py-3 border rounded-lg"
        }), React.createElement("select", {
            value: p.motivo || "",
            onChange: e => {
                const t = e.target.value;
                x({
                    ...p,
                    motivo: t,
                    imagens: []
                })
            },
            className: "w-full px-4 py-3 border rounded-lg"
        }, React.createElement("option", {
            value: ""
        }, "Selecione o motivo"), React.createElement("option", null, "Ajuste de Retorno"), React.createElement("option", null, "Ajuste de Pedágio (Campinas e Recife)")), Wl.includes(p.motivo) && React.createElement("div", {
            className: "border-2 border-dashed border-orange-300 bg-orange-50 rounded-lg p-4"
        }, React.createElement("p", {
            className: "text-sm font-bold text-orange-800 mb-2"
        }, "📎 Fotos OBRIGATÓRIAS (máx. 2)"), React.createElement("input", {
            type: "file",
            accept: "image/*",
            multiple: !0,
            onChange: async e => {
                const t = Array.from(e.target.files).slice(0, 2);
                if (t.length) {
                    s(!0);
                    try {
                        const e = [];
                        for (const a of t) a.size <= 1e7 && e.push(await Zl(a));
                        x({
                            ...p,
                            imagens: [...p.imagens || [], ...e].slice(0, 2)
                        }), ja("✅ Imagem adicionada!", "success")
                    } catch {
                        ja("Erro", "error")
                    }
                    s(!1), e.target.value = ""
                }
            },
            className: "w-full text-sm"
        }), p.imagens?.length > 0 && React.createElement("div", {
            className: "mt-3 flex gap-2"
        }, p.imagens.map((e, t) => React.createElement("div", {
            key: t,
            className: "relative"
        }, React.createElement("img", {
            src: e,
            className: "h-24 rounded border"
        }), React.createElement("button", {
            onClick: () => x({
                ...p,
                imagens: p.imagens.filter((e, a) => a !== t)
            }),
            className: "absolute -top-2 -right-2 bg-red-600 text-white rounded-full w-5 h-5 text-xs"
        }, "✕")))), React.createElement("p", {
            className: "text-xs text-gray-500 mt-2"
        }, p.imagens?.length || 0, "/2 fotos")), React.createElement("button", {
            onClick: Yl,
            disabled: c || !p.os || !p.motivo || Wl.includes(p.motivo) && !p.imagens?.length,
            className: "w-full bg-purple-900 text-white py-3 rounded-lg font-semibold disabled:opacity-50"
        }, c ? "⏳ Enviando..." : "Enviar"))), React.createElement("div", {
            className: "bg-white rounded-xl shadow p-6"
        }, React.createElement("h2", {
            className: "text-lg font-semibold mb-4"
        }, "📋 Minhas Submissões"), 0 === j.length ? React.createElement("p", {
            className: "text-gray-500"
        }, "Nenhuma submissão") : React.createElement("div", {
            className: "space-y-3"
        }, j.map(e => React.createElement("div", {
            key: e.id,
            className: "border rounded-lg p-4"
        }, React.createElement("div", {
            className: "flex justify-between items-start"
        }, React.createElement("div", null, React.createElement("p", {
            className: "font-mono text-lg font-bold"
        }, "OS: ", e.ordemServico), React.createElement("p", {
            className: "text-sm text-gray-600"
        }, e.motivo)), React.createElement("span", {
            className: "px-3 py-1 rounded-full text-xs font-bold " + ("aprovada" === e.status ? "bg-green-500 text-white" : "rejeitada" === e.status ? "bg-red-500 text-white" : "bg-yellow-500 text-white")
        }, e.status?.toUpperCase())), "rejeitada" === e.status && e.observacao && React.createElement("div", {
            className: "mt-2 p-2 bg-red-50 border border-red-200 rounded"
        }, React.createElement("p", {
            className: "text-xs text-red-800"
        }, React.createElement("strong", null, "Motivo da rejeição:"), " ", e.observacao)), e.temImagem && !e.imagemComprovante && React.createElement("button", {
            onClick: () => Fa(e.id),
            className: "mt-2 text-sm text-blue-600 hover:underline"
        }, "📷 Ver foto(s)"), e.imagemComprovante && React.createElement("div", {
            className: "mt-2 flex gap-2"
        }, e.imagemComprovante.split("|||").map((e, t) => React.createElement("img", {
            key: t,
            src: e,
            className: "h-20 rounded cursor-pointer",
            onClick: () => g(e)
        }))), React.createElement("p", {
            className: "text-xs text-gray-400 mt-2"
        }, e.timestamp)))))), "saque" === p.userTab && React.createElement(React.Fragment, null, null === ze ? React.createElement("div", {
            className: "flex items-center justify-center py-12"
        }, React.createElement("div", {
            className: "animate-spin rounded-full h-8 w-8 border-b-2 border-purple-600"
        }), React.createElement("span", {
            className: "ml-3"
        }, "Verificando horário...")) : ze.dentroHorario || Ge ? React.createElement(React.Fragment, null, Qe.length > 0 && React.createElement("div", {
            className: "space-y-2 mb-4"
        }, Qe.map(e => React.createElement("div", {
            key: e.id,
            className: "p-3 rounded-xl border-l-4 " + ("error" === e.tipo ? "bg-red-50 border-red-500" : "warning" === e.tipo ? "bg-yellow-50 border-yellow-500" : "success" === e.tipo ? "bg-green-50 border-green-500" : "bg-blue-50 border-blue-500")
        }, React.createElement("p", {
            className: "font-bold text-sm"
        }, e.titulo), React.createElement("p", {
            className: "text-xs text-gray-700"
        }, e.mensagem)))), ze && !ze.dentroHorario && Ge && React.createElement("div", {
            className: "bg-orange-100 border border-orange-300 rounded-xl p-3 mb-4 flex items-center gap-3"
        }, React.createElement("span", {
            className: "text-2xl"
        }, "⏰"), React.createElement("div", null, React.createElement("p", {
            className: "text-sm font-semibold text-orange-800"
        }, "Solicitação fora do horário"), React.createElement("p", {
            className: "text-xs text-orange-700"
        }, "Será processada ", yl()))), k ? T?.full_name ? React.createElement(React.Fragment, null, React.createElement("div", {
            className: "bg-white rounded-xl shadow mb-6"
        }, React.createElement("div", {
            className: "flex border-b overflow-x-auto"
        }, React.createElement("button", {
            onClick: () => x({
                ...p,
                saqueTab: "solicitar"
            }),
            className: "flex-1 py-3 font-semibold whitespace-nowrap px-2 " + (p.saqueTab && "solicitar" !== p.saqueTab ? "text-gray-500" : "text-green-700 border-b-2 border-green-600")
        }, "💰 Solicitar"), React.createElement("button", {
            onClick: () => x({
                ...p,
                saqueTab: "gratuidades"
            }),
            className: "flex-1 py-3 font-semibold whitespace-nowrap px-2 " + ("gratuidades" === p.saqueTab ? "text-pink-700 border-b-2 border-pink-600" : "text-gray-500")
        }, "🎁 Gratuidades"), React.createElement("button", {
            onClick: () => x({
                ...p,
                saqueTab: "dados"
            }),
            className: "flex-1 py-3 font-semibold whitespace-nowrap px-2 " + ("dados" === p.saqueTab ? "text-blue-700 border-b-2 border-blue-600" : "text-gray-500")
        }, "👤 Dados"), React.createElement("button", {
            onClick: () => x({
                ...p,
                saqueTab: "dashboard"
            }),
            className: "flex-1 py-3 font-semibold whitespace-nowrap px-2 " + ("dashboard" === p.saqueTab ? "text-purple-700 border-b-2 border-purple-600" : "text-gray-500")
        }, "📊 Dashboard")), React.createElement("div", {
            className: "p-6"
        }, "dashboard" === p.saqueTab && React.createElement(React.Fragment, null, (() => {
            const e = new Date,
                t = e.getMonth(),
                a = e.getFullYear(),
                l = M.filter(e => {
                    const l = new Date(e.created_at);
                    return l.getMonth() === t && l.getFullYear() === a
                }),
                r = l.filter(e => "aprovado" === e.status || "aprovado_gratuidade" === e.status),
                o = r.reduce((e, t) => e + parseFloat(t.final_amount || 0), 0),
                c = G.reduce((e, t) => e + (t.quantity - t.remaining), 0),
                s = G.reduce((e, t) => e + t.quantity, 0),
                n = [];
            for (let e = 5; e >= 0; e--) {
                const l = new Date(a, t - e, 1),
                    r = l.getMonth(),
                    o = l.getFullYear(),
                    c = M.filter(e => {
                        const t = new Date(e.created_at);
                        return t.getMonth() === r && t.getFullYear() === o && ("aprovado" === e.status || "aprovado_gratuidade" === e.status)
                    }),
                    s = c.reduce((e, t) => e + parseFloat(t.final_amount || 0), 0);
                n.push({
                    mes: l.toLocaleDateString("pt-BR", {
                        month: "short"
                    }).replace(".", ""),
                    valor: s,
                    qtd: c.length
                })
            }
            const m = Math.max(...n.map(e => e.valor), 1),
                i = M.filter(e => "aprovado" === e.status || "aprovado_gratuidade" === e.status).reduce((e, t) => e + parseFloat(t.final_amount || 0), 0),
                d = r.length > 0 ? o / r.length : 0;
            return React.createElement("div", {
                className: "space-y-6"
            }, React.createElement("div", {
                className: "grid grid-cols-1 md:grid-cols-3 gap-4"
            }, React.createElement("div", {
                className: "bg-gradient-to-br from-green-500 to-emerald-600 rounded-xl p-4 text-white"
            }, React.createElement("p", {
                className: "text-xs opacity-80"
            }, "💰 Sacado este mês"), React.createElement("p", {
                className: "text-2xl font-bold mt-1"
            }, er(o)), React.createElement("p", {
                className: "text-xs opacity-70 mt-1"
            }, r.length, " saque(s)")), React.createElement("div", {
                className: "bg-gradient-to-br from-purple-500 to-pink-600 rounded-xl p-4 text-white"
            }, React.createElement("p", {
                className: "text-xs opacity-80"
            }, "🎁 Gratuidades"), React.createElement("p", {
                className: "text-2xl font-bold mt-1"
            }, c, "/", s), React.createElement("p", {
                className: "text-xs opacity-70 mt-1"
            }, "usadas/total")), React.createElement("div", {
                className: "bg-gradient-to-br from-orange-500 to-red-500 rounded-xl p-4 text-white"
            }, React.createElement("p", {
                className: "text-xs opacity-80"
            }, "📈 Total Histórico"), React.createElement("p", {
                className: "text-2xl font-bold mt-1"
            }, er(i)), React.createElement("p", {
                className: "text-xs opacity-70 mt-1"
            }, "todos os tempos"))), React.createElement("div", {
                className: "bg-white border rounded-xl p-4"
            }, React.createElement("h3", {
                className: "font-semibold mb-4"
            }, "📊 Histórico de Saques (Últimos 6 meses)"), React.createElement("div", {
                className: "flex items-end justify-between gap-2 h-48"
            }, n.map((e, t) => React.createElement("div", {
                key: t,
                className: "flex-1 flex flex-col items-center"
            }, React.createElement("span", {
                className: "text-xs text-gray-600 mb-1"
            }, er(e.valor)), React.createElement("div", {
                className: "w-full bg-gradient-to-t from-green-500 to-emerald-400 rounded-t-lg transition-all duration-500",
                style: {
                    height: `${Math.max(e.valor/m*100,5)}%`,
                    minHeight: "20px"
                }
            }), React.createElement("span", {
                className: "text-xs font-semibold mt-2 text-gray-700"
            }, e.mes), React.createElement("span", {
                className: "text-xs text-gray-500"
            }, e.qtd, " saque(s)"))))), React.createElement("div", {
                className: "bg-gray-50 rounded-xl p-4"
            }, React.createElement("h3", {
                className: "font-semibold mb-3"
            }, "📋 Resumo do Mês"), React.createElement("div", {
                className: "grid grid-cols-2 gap-4 text-sm"
            }, React.createElement("div", {
                className: "flex justify-between"
            }, React.createElement("span", {
                className: "text-gray-600"
            }, "Média por saque:"), React.createElement("span", {
                className: "font-semibold"
            }, er(d))), React.createElement("div", {
                className: "flex justify-between"
            }, React.createElement("span", {
                className: "text-gray-600"
            }, "Pendentes:"), React.createElement("span", {
                className: "font-semibold text-yellow-600"
            }, l.filter(e => "aguardando_aprovacao" === e.status).length)), React.createElement("div", {
                className: "flex justify-between"
            }, React.createElement("span", {
                className: "text-gray-600"
            }, "Aprovados:"), React.createElement("span", {
                className: "font-semibold text-green-600"
            }, r.length)), React.createElement("div", {
                className: "flex justify-between"
            }, React.createElement("span", {
                className: "text-gray-600"
            }, "Rejeitados:"), React.createElement("span", {
                className: "font-semibold text-red-600"
            }, l.filter(e => "rejeitado" === e.status).length)))))
        })()), (!p.saqueTab || "solicitar" === p.saqueTab) && React.createElement(React.Fragment, null, (() => {
            const e = G.find(e => "ativa" === e.status && e.remaining > 0),
                t = !!e,
                a = e ? parseFloat(e.value) : 0,
                l = parseFloat(p.withdrawAmount) || 0,
                r = t && l > a,
                o = new Date,
                s = new Date(o.getTime() - 36e5),
                n = M.filter(e => new Date(e.created_at) >= s),
                m = Math.max(0, 2 - n.length),
                i = n.map(e => parseFloat(e.requested_amount)),
                d = i.includes(l) && l > 0;
            let u = null;
            if (n.length >= 2) {
                const e = new Date(Math.min(...n.map(e => new Date(e.created_at).getTime()))),
                    t = new Date(e.getTime() + 36e5) - o;
                t > 0 && (u = Math.ceil(t / 6e4))
            }
            return React.createElement("div", {
                className: "space-y-4"
            }, React.createElement("div", {
                className: "rounded-lg p-4 border " + (0 === m ? "bg-red-50 border-red-300" : 1 === m ? "bg-orange-50 border-orange-300" : "bg-blue-50 border-blue-300")
            }, React.createElement("div", {
                className: "flex items-center justify-between"
            }, React.createElement("div", {
                className: "flex items-center gap-2"
            }, React.createElement("span", {
                className: "text-2xl"
            }, 0 === m ? "🚫" : 1 === m ? "⚠️" : "✅"), React.createElement("div", null, React.createElement("p", {
                className: "font-semibold " + (0 === m ? "text-red-800" : 1 === m ? "text-orange-800" : "text-blue-800")
            }, 0 === m ? "Limite atingido" : `${m} saque(s) disponível(is)`), React.createElement("p", {
                className: "text-xs " + (0 === m ? "text-red-600" : 1 === m ? "text-orange-600" : "text-blue-600")
            }, 0 === m ? `Aguarde ${u||"?"} min para solicitar novamente` : "Máximo 2 saques por hora com valores diferentes"))), React.createElement("div", {
                className: "flex gap-1"
            }, [0, 1].map(e => React.createElement("div", {
                key: e,
                className: "w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold " + (e < n.length ? "bg-gray-400 text-white" : "bg-green-500 text-white")
            }, e < n.length ? "✓" : e + 1 - n.length)))), i.length > 0 && React.createElement("p", {
                className: "text-xs mt-2 text-gray-600"
            }, "Valores já usados na última hora: ", i.map(e => `R$ ${e.toFixed(2)}`).join(", "))), t && React.createElement("div", {
                className: "bg-green-50 border border-green-300 rounded-lg p-4"
            }, React.createElement("p", {
                className: "text-green-800 font-semibold"
            }, "🎁 Você possui gratuidade ativa!"), React.createElement("p", {
                className: "text-green-700 text-sm mt-1"
            }, "Valor máximo permitido: ", React.createElement("strong", null, er(a))), React.createElement("p", {
                className: "text-green-600 text-xs mt-1"
            }, "Restam ", e.remaining, " uso(s) desta gratuidade")), !t && React.createElement("div", {
                className: "bg-yellow-50 border border-yellow-300 rounded-lg p-4"
            }, React.createElement("p", {
                className: "text-yellow-800 font-semibold"
            }, "⚠️ Atenção!"), React.createElement("p", {
                className: "text-yellow-700 text-sm mt-1"
            }, "Conforme termo de uso do saque emergencial, será cobrado um valor de ", React.createElement("strong", null, "4,5%"), " na solicitação.")), React.createElement("div", null, React.createElement("label", {
                className: "block text-sm font-semibold mb-1"
            }, "Valor ", t && React.createElement("span", {
                className: "text-green-600 text-xs"
            }, "(máx: ", er(a), ")")), React.createElement("input", {
                type: "number",
                value: p.withdrawAmount || "",
                onChange: e => x({
                    ...p,
                    withdrawAmount: e.target.value
                }),
                className: "w-full px-4 py-3 border rounded-lg text-lg " + (r || d ? "border-red-500 bg-red-50" : ""),
                disabled: 0 === m
            }), r && React.createElement("p", {
                className: "text-red-600 text-sm mt-1 font-semibold"
            }, "❌ Valor excede o limite da gratuidade (", er(a), ")"), d && !r && React.createElement("p", {
                className: "text-red-600 text-sm mt-1 font-semibold"
            }, "❌ Você já solicitou R$ ", l.toFixed(2), " na última hora. Escolha outro valor.")), p.withdrawAmount && parseFloat(p.withdrawAmount) > 0 && !r && !d && (() => {
                const e = (e => {
                    const t = G.find(e => "ativa" === e.status && e.remaining > 0),
                        a = !!t,
                        l = a ? 0 : .045 * e;
                    return {
                        fee: l,
                        final: e - l,
                        hasGrat: a,
                        maxGratValue: t ? parseFloat(t.value) : 0,
                        gratAtiva: t
                    }
                })(parseFloat(p.withdrawAmount));
                return React.createElement("div", {
                    className: "bg-gray-50 rounded-lg p-4 space-y-2"
                }, React.createElement("div", {
                    className: "flex justify-between"
                }, React.createElement("span", null, "Solicitado:"), React.createElement("span", {
                    className: "font-bold"
                }, er(p.withdrawAmount))), React.createElement("div", {
                    className: "flex justify-between"
                }, React.createElement("span", null, "Taxa:"), React.createElement("span", {
                    className: e.hasGrat ? "text-green-600 font-bold" : "text-red-600"
                }, e.hasGrat ? "ISENTA" : `-${er(e.fee)}`)), React.createElement("hr", null), React.createElement("div", {
                    className: "flex justify-between text-lg"
                }, React.createElement("span", {
                    className: "font-bold"
                }, "Receber:"), React.createElement("span", {
                    className: "font-bold text-green-700"
                }, er(e.final))))
            })(), React.createElement("button", {
                onClick: Vl,
                disabled: c || !p.withdrawAmount || r || d || 0 === m,
                className: "w-full bg-green-600 text-white py-3 rounded-lg font-bold disabled:opacity-50"
            }, c ? "..." : 0 === m ? "🚫 Limite Atingido" : "💸 Solicitar"))
        })(), React.createElement("h3", {
            className: "text-lg font-semibold mt-8 mb-4"
        }, "📋 Histórico"), 0 === M.length ? React.createElement("p", {
            className: "text-gray-500"
        }, "Nenhum saque") : React.createElement("div", {
            className: "space-y-3"
        }, M.map(e => {
            const t = "aguardando_aprovacao" === e.status && Date.now() - new Date(e.created_at) > 36e5,
                a = "aprovado" === e.status || "aprovado_gratuidade" === e.status ? "Saque aprovado, em instantes será feito a transferência para o seu banco!" : "inativo" === e.status ? "Saque temporariamente inativo por questões técnicas" : "rejeitado" === e.status && e.reject_reason ? `Motivo: ${e.reject_reason}` : null;
            return React.createElement("div", {
                key: e.id,
                className: "border rounded-lg p-4 " + (t ? "border-red-400 bg-red-50" : e.status?.includes("aprovado") ? "border-green-400 bg-green-50" : "rejeitado" === e.status ? "border-red-300 bg-red-50" : "inativo" === e.status ? "border-orange-300 bg-orange-50" : "")
            }, React.createElement("div", {
                className: "flex justify-between"
            }, React.createElement("div", null, React.createElement("p", {
                className: "font-bold"
            }, er(e.requested_amount)), React.createElement("p", {
                className: "text-sm text-gray-600"
            }, "Receber: ", er(e.final_amount))), React.createElement("span", {
                className: "px-3 py-1 rounded-full text-xs font-bold h-fit " + (e.status?.includes("aprovado") ? "bg-green-500 text-white" : "rejeitado" === e.status ? "bg-red-500 text-white" : "inativo" === e.status ? "bg-orange-500 text-white" : "bg-yellow-500 text-white")
            }, t ? "⚠️ ATRASADO" : "aprovado" === e.status || "aprovado_gratuidade" === e.status ? "✅ Aprovado" : "rejeitado" === e.status ? "❌ Rejeitado" : "inativo" === e.status ? "⚠️ Inativo" : "⏳ Aguardando")), a && React.createElement("p", {
                className: "text-sm mt-2 font-semibold " + (e.status?.includes("aprovado") ? "text-green-700" : "rejeitado" === e.status ? "text-red-600" : "text-orange-600")
            }, a), t && React.createElement("p", {
                className: "text-red-600 text-sm mt-2 font-semibold"
            }, "Entre em contato com o suporte"), React.createElement("p", {
                className: "text-xs text-gray-400 mt-2"
            }, new Date(e.created_at).toLocaleString("pt-BR")))
        }))), "dados" === p.saqueTab && React.createElement("div", {
            className: "space-y-4"
        }, T && !F ? React.createElement(React.Fragment, null, React.createElement("div", {
            className: "bg-green-50 border-2 border-green-300 rounded-xl p-5"
        }, React.createElement("div", {
            className: "flex items-center gap-2 mb-4"
        }, React.createElement("span", {
            className: "text-2xl"
        }, "✅"), React.createElement("h3", {
            className: "font-bold text-green-800"
        }, "Dados Validados")), React.createElement("div", {
            className: "space-y-3"
        }, React.createElement("div", {
            className: "flex justify-between items-center py-2 border-b border-green-200"
        }, React.createElement("span", {
            className: "text-gray-600 text-sm"
        }, "Nome Completo"), React.createElement("span", {
            className: "font-semibold text-gray-800"
        }, T.full_name)), React.createElement("div", {
            className: "flex justify-between items-center py-2 border-b border-green-200"
        }, React.createElement("span", {
            className: "text-gray-600 text-sm"
        }, "CPF"), React.createElement("span", {
            className: "font-semibold text-gray-800"
        }, T.cpf)), React.createElement("div", {
            className: "flex justify-between items-center py-2 border-b border-green-200"
        }, React.createElement("span", {
            className: "text-gray-600 text-sm"
        }, "Tipo da Chave PIX"), React.createElement("span", {
            className: "px-2 py-1 bg-green-200 text-green-800 rounded-full text-xs font-bold"
        }, {
            cpf: "🪪 CPF",
            cnpj: "🏢 CNPJ",
            telefone: "📱 Telefone",
            email: "📧 Email",
            aleatoria: "🔑 Aleatória"
        } [T.pix_tipo] || T.pix_tipo)), React.createElement("div", {
            className: "flex justify-between items-center py-2"
        }, React.createElement("span", {
            className: "text-gray-600 text-sm"
        }, "Chave PIX"), React.createElement("span", {
            className: "font-semibold text-gray-800"
        }, T.pix_key))), React.createElement("button", {
            onClick: () => $(!0),
            className: "w-full mt-4 bg-white border-2 border-green-500 text-green-700 py-3 rounded-lg font-bold hover:bg-green-100 transition"
        }, "✏️ Editar Dados")), L.length > 0 && React.createElement("div", {
            className: "bg-gray-50 border border-gray-200 rounded-xl p-4"
        }, React.createElement("h4", {
            className: "font-semibold text-gray-700 mb-3 flex items-center gap-2"
        }, React.createElement("span", null, "📋"), " Histórico de Alterações"), React.createElement("div", {
            className: "space-y-2 max-h-48 overflow-y-auto"
        }, L.map((e, t) => React.createElement("div", {
            key: t,
            className: "bg-white border border-gray-200 rounded-lg p-3 text-sm"
        }, React.createElement("div", {
            className: "flex justify-between items-start"
        }, React.createElement("div", null, React.createElement("span", {
            className: "font-semibold text-gray-700"
        }, "ALTERACAO_NOME" === e.action && "👤 Nome alterado", "ALTERACAO_CPF" === e.action && "🪪 CPF alterado", "ALTERACAO_PIX" === e.action && "💳 Chave PIX alterada", "CADASTRO_DADOS" === e.action && "✅ Cadastro inicial"), e.old_value && e.new_value && React.createElement("p", {
            className: "text-gray-500 text-xs mt-1"
        }, "De: ", React.createElement("span", {
            className: "line-through text-red-500"
        }, e.old_value), React.createElement("br", null), "Para: ", React.createElement("span", {
            className: "text-green-600 font-medium"
        }, e.new_value))), React.createElement("span", {
            className: "text-xs text-gray-400"
        }, new Date(e.created_at).toLocaleDateString("pt-BR"), " ", new Date(e.created_at).toLocaleTimeString("pt-BR", {
            hour: "2-digit",
            minute: "2-digit"
        })))))))) : React.createElement(React.Fragment, null, T && F && React.createElement("div", {
            className: "bg-yellow-50 border border-yellow-300 rounded-lg p-3 mb-2"
        }, React.createElement("p", {
            className: "text-yellow-800 text-sm flex items-center gap-2"
        }, React.createElement("span", null, "⚠️"), " Você está editando seus dados. As alterações serão registradas no histórico.")), React.createElement("div", null, React.createElement("label", {
            className: "block text-sm font-semibold mb-1"
        }, "Nome Completo"), React.createElement("input", {
            type: "text",
            value: p.finName ?? T?.full_name ?? "",
            onChange: e => x({
                ...p,
                finName: e.target.value
            }),
            className: "w-full px-4 py-2 border rounded-lg",
            placeholder: "Seu nome completo"
        })), React.createElement("div", null, React.createElement("label", {
            className: "block text-sm font-semibold mb-1"
        }, "CPF"), React.createElement("input", {
            type: "text",
            value: p.finCpf ?? T?.cpf ?? "",
            onChange: e => x({
                ...p,
                finCpf: Xl(e.target.value)
            }),
            className: "w-full px-4 py-2 border rounded-lg",
            placeholder: "000.000.000-00",
            maxLength: 14
        })), React.createElement("div", null, React.createElement("label", {
            className: "block text-sm font-semibold mb-2"
        }, "Tipo da Chave PIX"), React.createElement("div", {
            className: "grid grid-cols-5 gap-2"
        }, [{
            id: "cpf",
            label: "CPF",
            icon: "🪪"
        }, {
            id: "cnpj",
            label: "CNPJ",
            icon: "🏢"
        }, {
            id: "telefone",
            label: "Telefone",
            icon: "📱"
        }, {
            id: "email",
            label: "Email",
            icon: "📧"
        }, {
            id: "aleatoria",
            label: "Aleatória",
            icon: "🔑"
        }].map(e => React.createElement("button", {
            key: e.id,
            type: "button",
            onClick: () => x({
                ...p,
                pixTipo: e.id,
                finPix: ""
            }),
            className: "p-2 rounded-lg border-2 text-center transition-all " + (p.pixTipo === e.id ? "border-blue-500 bg-blue-50 text-blue-700" : "border-gray-200 hover:border-gray-300")
        }, React.createElement("span", {
            className: "text-xl"
        }, e.icon), React.createElement("p", {
            className: "text-xs font-semibold mt-1"
        }, e.label))))), React.createElement("div", null, React.createElement("label", {
            className: "block text-sm font-semibold mb-1"
        }, "Chave PIX"), React.createElement("input", {
            type: "email" === p.pixTipo ? "email" : "text",
            value: p.finPix ?? T?.pix_key ?? "",
            onChange: e => x({
                ...p,
                finPix: ar(e.target.value, p.pixTipo)
            }),
            placeholder: lr(p.pixTipo),
            disabled: !p.pixTipo,
            maxLength: "cpf" === p.pixTipo ? 14 : "cnpj" === p.pixTipo ? 18 : "telefone" === p.pixTipo ? 15 : 100,
            className: "w-full px-4 py-2 border rounded-lg transition-all " + (p.pixTipo ? p.finPix ? tr(p.finPix, p.pixTipo).valido ? "border-green-500 bg-green-50" : "border-red-500 bg-red-50" : "" : "bg-gray-100 cursor-not-allowed")
        }), p.finPix && p.pixTipo && React.createElement("p", {
            className: "mt-1 text-sm " + (tr(p.finPix, p.pixTipo).valido ? "text-green-600" : "text-red-600")
        }, tr(p.finPix, p.pixTipo).mensagem), !p.pixTipo && React.createElement("p", {
            className: "mt-1 text-sm text-gray-500"
        }, "👆 Selecione o tipo da chave acima")), React.createElement("div", {
            className: "flex gap-2"
        }, F && React.createElement("button", {
            onClick: () => {
                $(!1), x(e => ({
                    ...e,
                    finName: T?.full_name || "",
                    finCpf: T?.cpf || "",
                    finPix: T?.pix_key || "",
                    pixTipo: T?.pix_tipo || ""
                }))
            },
            className: "flex-1 bg-gray-200 text-gray-700 py-3 rounded-lg font-bold hover:bg-gray-300 transition"
        }, "✕ Cancelar"), React.createElement("button", {
            onClick: Bl,
            disabled: c || !p.pixTipo,
            className: (F ? "flex-1" : "w-full") + " bg-blue-600 text-white py-3 rounded-lg font-bold disabled:opacity-50 disabled:cursor-not-allowed hover:bg-blue-700 transition"
        }, c ? "..." : "💾 Salvar Dados")))), "gratuidades" === p.saqueTab && React.createElement(React.Fragment, null, React.createElement("h3", {
            className: "font-semibold mb-4"
        }, "🎁 Minhas Gratuidades"), 0 === G.length ? React.createElement("p", {
            className: "text-gray-500"
        }, "Nenhuma") : React.createElement("div", {
            className: "space-y-3"
        }, G.map(e => React.createElement("div", {
            key: e.id,
            className: "border rounded-lg p-4 " + ("ativa" === e.status ? "border-green-300 bg-green-50" : "bg-gray-50")
        }, React.createElement("div", {
            className: "flex justify-between"
        }, React.createElement("div", null, React.createElement("p", {
            className: "font-bold"
        }, e.remaining, "/", e.quantity, " restantes"), React.createElement("p", {
            className: "text-sm text-gray-600"
        }, "Valor: ", er(e.value))), React.createElement("span", {
            className: "px-3 py-1 rounded-full text-xs font-bold h-fit " + ("ativa" === e.status ? "bg-green-500 text-white" : "bg-gray-400 text-white")
        }, e.status))))))))) : React.createElement("div", {
            className: "bg-white rounded-xl shadow p-6"
        }, React.createElement("h2", {
            className: "text-xl font-bold text-purple-900 mb-4"
        }, "💳 Cadastrar Dados Financeiros"), React.createElement("p", {
            className: "text-sm text-gray-600 mb-4"
        }, "Preencha seus dados para receber os saques via PIX."), React.createElement("div", {
            className: "space-y-4"
        }, React.createElement("div", null, React.createElement("label", {
            className: "block text-sm font-semibold mb-1"
        }, "Código do Profissional"), React.createElement("input", {
            type: "text",
            value: l.codProfissional,
            disabled: !0,
            className: "w-full px-4 py-2 border rounded-lg bg-gray-100 text-gray-600"
        })), React.createElement("div", null, React.createElement("label", {
            className: "block text-sm font-semibold mb-1"
        }, "Nome Completo *"), React.createElement("input", {
            type: "text",
            value: p.finName || "",
            onChange: e => x({
                ...p,
                finName: e.target.value
            }),
            className: "w-full px-4 py-2 border rounded-lg",
            placeholder: "Seu nome completo"
        })), React.createElement("div", null, React.createElement("label", {
            className: "block text-sm font-semibold mb-1"
        }, "CPF *"), React.createElement("input", {
            type: "text",
            value: p.finCpf || "",
            onChange: e => x({
                ...p,
                finCpf: Xl(e.target.value)
            }),
            className: "w-full px-4 py-2 border rounded-lg",
            placeholder: "000.000.000-00",
            maxLength: 14
        })), React.createElement("div", null, React.createElement("label", {
            className: "block text-sm font-semibold mb-2"
        }, "Tipo da Chave PIX *"), React.createElement("div", {
            className: "grid grid-cols-5 gap-2"
        }, [{
            id: "cpf",
            label: "CPF",
            icon: "🪪"
        }, {
            id: "cnpj",
            label: "CNPJ",
            icon: "🏢"
        }, {
            id: "telefone",
            label: "Telefone",
            icon: "📱"
        }, {
            id: "email",
            label: "Email",
            icon: "📧"
        }, {
            id: "aleatoria",
            label: "Aleatória",
            icon: "🔑"
        }].map(e => React.createElement("button", {
            key: e.id,
            type: "button",
            onClick: () => x({
                ...p,
                pixTipo: e.id,
                finPix: ""
            }),
            className: "p-2 rounded-lg border-2 text-center transition-all " + (p.pixTipo === e.id ? "border-purple-500 bg-purple-50 text-purple-700" : "border-gray-200 hover:border-gray-300")
        }, React.createElement("span", {
            className: "text-xl"
        }, e.icon), React.createElement("p", {
            className: "text-xs font-semibold mt-1"
        }, e.label))))), React.createElement("div", null, React.createElement("label", {
            className: "block text-sm font-semibold mb-1"
        }, "Chave PIX *"), React.createElement("input", {
            type: "email" === p.pixTipo ? "email" : "text",
            value: p.finPix || "",
            onChange: e => x({
                ...p,
                finPix: ar(e.target.value, p.pixTipo)
            }),
            placeholder: lr(p.pixTipo),
            disabled: !p.pixTipo,
            maxLength: "cpf" === p.pixTipo ? 14 : "cnpj" === p.pixTipo ? 18 : "telefone" === p.pixTipo ? 15 : 100,
            className: "w-full px-4 py-2 border rounded-lg transition-all " + (p.pixTipo ? p.finPix ? tr(p.finPix, p.pixTipo).valido ? "border-green-500 bg-green-50" : "border-red-500 bg-red-50" : "" : "bg-gray-100 cursor-not-allowed")
        }), p.finPix && p.pixTipo && React.createElement("p", {
            className: "mt-1 text-sm " + (tr(p.finPix, p.pixTipo).valido ? "text-green-600" : "text-red-600")
        }, tr(p.finPix, p.pixTipo).mensagem), !p.pixTipo && React.createElement("p", {
            className: "mt-1 text-sm text-gray-500"
        }, "👆 Selecione o tipo da chave acima")), React.createElement("button", {
            onClick: Bl,
            disabled: c || !p.pixTipo || !p.finName || !p.finCpf || !p.finPix,
            className: "w-full bg-purple-600 text-white py-3 rounded-lg font-bold disabled:opacity-50 disabled:cursor-not-allowed hover:bg-purple-700 transition"
        }, c ? "⏳ Salvando..." : "💾 Salvar Dados"))) : React.createElement("div", {
            className: "bg-white rounded-xl shadow p-6"
        }, React.createElement("h2", {
            className: "text-2xl font-bold text-purple-900 mb-4 text-center"
        }, "📋 Termos de Uso"), React.createElement("div", {
            className: "bg-gray-50 rounded-lg p-4 mb-6 max-h-80 overflow-y-auto text-sm"
        }, React.createElement("p", {
            className: "text-gray-700 leading-relaxed"
        }, "Uma taxa administrativa de 4,5% será aplicada sobre o valor solicitado e deduzida automaticamente na transferência. As solicitações são processadas de segunda a sexta, das 09:00 às 18:00, e aos sábados, das 08:00 às 12:00. Solicitações feitas fora desse horário serão atendidas no próximo dia útil. É sua responsabilidade garantir que as informações fornecidas estejam corretas, pois não nos responsabilizamos por atrasos ou transferências erradas causadas por dados incorretos. O dinheiro será transferido em até 1 hora após a confirmação, dentro do horário de funcionamento.")), React.createElement("button", {
            onClick: zl,
            disabled: c,
            className: "w-full bg-purple-600 text-white py-3 rounded-lg font-bold disabled:opacity-50"
        }, c ? "Aguarde..." : "✓ Aceitar e Continuar"))) : React.createElement("div", {
            className: "space-y-4"
        }, Qe.map(e => React.createElement("div", {
            key: e.id,
            className: "p-4 rounded-xl border-l-4 " + ("error" === e.tipo ? "bg-red-50 border-red-500" : "warning" === e.tipo ? "bg-yellow-50 border-yellow-500" : "success" === e.tipo ? "bg-green-50 border-green-500" : "bg-blue-50 border-blue-500")
        }, React.createElement("p", {
            className: "font-bold text-sm mb-1"
        }, e.titulo), React.createElement("p", {
            className: "text-sm text-gray-700"
        }, e.mensagem))), React.createElement("div", {
            className: "bg-orange-50 border-2 border-orange-400 rounded-2xl p-6"
        }, React.createElement("div", {
            className: "text-center mb-6"
        }, React.createElement("div", {
            className: "text-6xl mb-4"
        }, "🕐"), React.createElement("h2", {
            className: "text-xl font-bold text-orange-800 mb-2"
        }, "Fora do Horário de Atendimento"), React.createElement("p", {
            className: "text-orange-700"
        }, "O atendimento de saques estará disponível novamente ", React.createElement("strong", null, yl()), ".")), React.createElement("div", {
            className: "bg-white rounded-xl p-4 mb-6"
        }, React.createElement("p", {
            className: "text-sm text-gray-700 text-center"
        }, "⚠️ Você pode solicitar o saque agora, mas ele só será processado quando o atendimento reabrir.")), React.createElement("div", {
            className: "bg-orange-100 rounded-xl p-4"
        }, React.createElement("p", {
            className: "text-sm font-semibold text-orange-800 mb-4 text-center"
        }, "Arraste o cursor para confirmar que entendeu:"), React.createElement("div", {
            className: "relative h-14 bg-orange-200 rounded-full overflow-hidden touch-none select-none",
            onTouchStart: e => {
                const t = e.touches[0],
                    a = e.currentTarget.getBoundingClientRect(),
                    l = Math.max(0, Math.min(100, (t.clientX - a.left) / a.width * 100));
                Je(l)
            },
            onTouchMove: e => {
                const t = e.touches[0],
                    a = e.currentTarget.getBoundingClientRect(),
                    l = Math.max(0, Math.min(100, (t.clientX - a.left) / a.width * 100));
                Je(l), l >= 95 && !Ge && (We(!0), ja("✅ Você pode prosseguir com a solicitação!", "success"))
            },
            onMouseDown: e => {
                const t = e.currentTarget.getBoundingClientRect(),
                    a = Math.max(0, Math.min(100, (e.clientX - t.left) / t.width * 100));
                Je(a);
                const l = e => {
                        const a = Math.max(0, Math.min(100, (e.clientX - t.left) / t.width * 100));
                        Je(a), a >= 95 && !Ge && (We(!0), ja("✅ Você pode prosseguir com a solicitação!", "success"))
                    },
                    r = () => {
                        document.removeEventListener("mousemove", l), document.removeEventListener("mouseup", r)
                    };
                document.addEventListener("mousemove", l), document.addEventListener("mouseup", r)
            }
        }, React.createElement("div", {
            className: "absolute top-0 left-0 h-full bg-gradient-to-r from-orange-400 via-yellow-400 to-green-500 rounded-full",
            style: {
                width: `${Ve}%`,
                transition: "none"
            }
        }), React.createElement("div", {
            className: "absolute top-1 w-12 h-12 bg-white rounded-full shadow-lg flex items-center justify-center text-2xl pointer-events-none border-2 border-orange-300",
            style: {
                left: `calc(${Ve}% - ${.48*Ve}px)`,
                transition: "none",
                transform: Ve >= 95 ? "scale(1.1)" : "scale(1)"
            }
        }, Ve < 95 ? "👉" : "✅"), React.createElement("div", {
            className: "absolute inset-0 flex items-center justify-end pr-4 pointer-events-none"
        }, React.createElement("span", {
            className: "font-bold text-sm " + (Ve < 95 ? "text-orange-700" : "text-green-700")
        }, Ve < 30 ? "Arraste →→→" : Ve < 95 ? "Continue →" : "✓ OK!"))))))), "indicacoes" === p.userTab && React.createElement(React.Fragment, null, React.createElement("div", {
            className: "bg-gradient-to-br from-blue-600 to-purple-700 rounded-xl shadow-lg p-6 mb-6 text-white"
        }, React.createElement("div", {
            className: "flex items-center gap-4 mb-4"
        }, React.createElement("div", {
            className: "text-5xl"
        }, "🔗"), React.createElement("div", null, React.createElement("h2", {
            className: "text-2xl font-bold"
        }, "Indique e Ganhe!"), React.createElement("p", {
            className: "text-blue-200"
        }, "Escolha uma promoção e compartilhe seu link de indicação"))), p.statsIndicacao && React.createElement("div", {
            className: "grid grid-cols-4 gap-3"
        }, React.createElement("div", {
            className: "bg-white/10 rounded-lg p-3 text-center"
        }, React.createElement("p", {
            className: "text-2xl font-bold"
        }, p.statsIndicacao.total || 0), React.createElement("p", {
            className: "text-xs text-blue-200"
        }, "Total")), React.createElement("div", {
            className: "bg-yellow-500/30 rounded-lg p-3 text-center"
        }, React.createElement("p", {
            className: "text-2xl font-bold"
        }, p.statsIndicacao.pendentes || 0), React.createElement("p", {
            className: "text-xs text-yellow-200"
        }, "Pendentes")), React.createElement("div", {
            className: "bg-green-500/30 rounded-lg p-3 text-center"
        }, React.createElement("p", {
            className: "text-2xl font-bold"
        }, p.statsIndicacao.aprovadas || 0), React.createElement("p", {
            className: "text-xs text-green-200"
        }, "Aprovadas")), React.createElement("div", {
            className: "bg-red-500/30 rounded-lg p-3 text-center"
        }, React.createElement("p", {
            className: "text-2xl font-bold"
        }, p.statsIndicacao.rejeitadas || 0), React.createElement("p", {
            className: "text-xs text-red-200"
        }, "Rejeitadas")))), React.createElement("div", {
            className: "bg-white rounded-xl shadow p-6 mb-6"
        }, React.createElement("h2", {
            className: "text-xl font-bold text-purple-800 mb-4"
        }, "🎯 Promoções de Indicação Disponíveis"), 0 === ee.length ? React.createElement("div", {
            className: "text-center py-8 text-gray-500"
        }, React.createElement("p", {
            className: "text-4xl mb-2"
        }, "📢"), React.createElement("p", null, "Nenhuma promoção disponível no momento"), React.createElement("p", {
            className: "text-sm"
        }, "Fique atento, novas promoções podem aparecer a qualquer momento!")) : React.createElement("div", {
            className: "grid md:grid-cols-2 gap-4"
        }, ee.map(e => React.createElement("div", {
            key: e.id,
            className: "border-2 border-purple-200 bg-gradient-to-br from-purple-50 to-white rounded-xl p-6"
        }, React.createElement("div", {
            className: "flex justify-between items-start mb-3"
        }, React.createElement("span", {
            className: "px-3 py-1 bg-green-500 text-white rounded-full text-xs font-bold"
        }, "🔥 ATIVA")), React.createElement("p", {
            className: "text-lg font-bold text-gray-800 mb-1"
        }, "📍 ", e.regiao), React.createElement("p", {
            className: "text-3xl font-bold text-green-600 mb-3"
        }, er(e.valor_bonus)), e.detalhes && React.createElement("div", {
            className: "bg-white border border-purple-200 rounded-lg p-3 mb-4"
        }, React.createElement("p", {
            className: "text-sm text-gray-700 whitespace-pre-wrap"
        }, e.detalhes)), p.linkPromoSelecionada === e.id && p.meuLinkIndicacao?.token ? React.createElement("div", {
            className: "space-y-3"
        }, React.createElement("div", {
            className: "bg-purple-100 rounded-lg p-3"
        }, React.createElement("p", {
            className: "text-xs text-purple-600 mb-1"
        }, "Seu link para esta promoção:"), React.createElement("div", {
            className: "flex gap-2"
        }, React.createElement("input", {
            type: "text",
            readOnly: !0,
            value: `${window.location.origin}/#/indicar/${p.meuLinkIndicacao.token}`,
            className: "flex-1 px-3 py-2 bg-white border border-purple-300 rounded-lg text-gray-800 font-mono text-xs"
        }), React.createElement("button", {
            onClick: () => {
                navigator.clipboard.writeText(`${window.location.origin}/#/indicar/${p.meuLinkIndicacao.token}`), ja("✅ Link copiado!", "success")
            },
            className: "px-3 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg font-bold text-sm"
        }, "📋"))), React.createElement("button", {
            onClick: () => {
                const e = `🚀 Fala, parceiro(a)!\n\nEstou te indicando para realizar entregas comigo no aplicativo TUTTS! 💜📦 \n\nFaça seu cadastro pelo link abaixo, rode pelo menos 5 dias e garanta um bônus de R$ 30,00 no final! 💰✨\n\n👉 Link para cadastro: ${window.location.origin}/#/indicar/${p.meuLinkIndicacao.token}\n\nVem ganhar com a gente! 🛵🔥`;
                window.open(`https://wa.me/?text=${encodeURIComponent(e)}`, "_blank")
            },
            className: "w-full px-4 py-3 bg-green-600 hover:bg-green-700 text-white rounded-lg font-semibold flex items-center justify-center gap-2"
        }, React.createElement("span", null, "📱"), " Compartilhar no WhatsApp")) : React.createElement("button", {
            onClick: async () => {
                try {
                    s(!0);
                    const t = await fetch(`${API_URL}/indicacao-link/gerar`, {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json"
                        },
                        body: JSON.stringify({
                            user_cod: l.codProfissional,
                            user_name: l.fullName,
                            promocao_id: e.id,
                            regiao: e.regiao,
                            valor_bonus: e.valor_bonus
                        })
                    });
                    if (!t.ok) {
                        const e = await t.json().catch(() => ({}));
                        return ja("❌ Erro: " + (e.error || t.status), "error"), void s(!1)
                    }
                    const a = await t.json();
                    if (!a || !a.token) return ja("❌ Erro: token não gerado", "error"), void s(!1);
                    x({
                        ...p,
                        meuLinkIndicacao: a,
                        linkPromoSelecionada: e.id
                    }), ja("✅ Link gerado!", "success")
                } catch (e) {
                    ja("❌ Erro: " + e.message, "error")
                }
                s(!1)
            },
            disabled: c,
            className: "w-full px-4 py-3 bg-purple-600 hover:bg-purple-700 text-white rounded-lg font-semibold disabled:opacity-50"
        }, c ? "⏳ Gerando..." : "🔗 Gerar Link de Indicação"))))), React.createElement("div", {
            className: "bg-white rounded-xl shadow p-6 mb-6"
        }, React.createElement("h3", {
            className: "text-lg font-bold text-gray-800 mb-4"
        }, "📖 Como Funciona"), React.createElement("div", {
            className: "grid md:grid-cols-4 gap-4"
        }, React.createElement("div", {
            className: "bg-blue-50 rounded-lg p-4 text-center"
        }, React.createElement("div", {
            className: "text-3xl mb-2"
        }, "1️⃣"), React.createElement("p", {
            className: "font-semibold text-blue-800"
        }, "Escolha"), React.createElement("p", {
            className: "text-sm text-gray-600"
        }, "Selecione uma promoção ativa")), React.createElement("div", {
            className: "bg-purple-50 rounded-lg p-4 text-center"
        }, React.createElement("div", {
            className: "text-3xl mb-2"
        }, "2️⃣"), React.createElement("p", {
            className: "font-semibold text-purple-800"
        }, "Gere o Link"), React.createElement("p", {
            className: "text-sm text-gray-600"
        }, "Clique para criar seu link único")), React.createElement("div", {
            className: "bg-green-50 rounded-lg p-4 text-center"
        }, React.createElement("div", {
            className: "text-3xl mb-2"
        }, "3️⃣"), React.createElement("p", {
            className: "font-semibold text-green-800"
        }, "Compartilhe"), React.createElement("p", {
            className: "text-sm text-gray-600"
        }, "Envie pelo WhatsApp")), React.createElement("div", {
            className: "bg-yellow-50 rounded-lg p-4 text-center"
        }, React.createElement("div", {
            className: "text-3xl mb-2"
        }, "4️⃣"), React.createElement("p", {
            className: "font-semibold text-yellow-800"
        }, "Ganhe"), React.createElement("p", {
            className: "text-sm text-gray-600"
        }, "Receba o bônus no repasse")))), React.createElement("div", {
            className: "bg-white rounded-xl shadow p-6"
        }, React.createElement("h2", {
            className: "text-lg font-bold text-gray-800 mb-4"
        }, "📋 Minhas Indicações"), 0 === re.length ? React.createElement("div", {
            className: "text-center py-8 text-gray-500"
        }, React.createElement("p", {
            className: "text-4xl mb-2"
        }, "👥"), React.createElement("p", null, "Você ainda não tem indicações"), React.createElement("p", {
            className: "text-sm"
        }, "Compartilhe seu link e comece a indicar!")) : React.createElement("div", {
            className: "space-y-4"
        }, re.map(e => React.createElement("div", {
            key: e.id,
            className: "border rounded-xl p-4 " + ("aprovada" === e.status ? "border-green-300 bg-green-50" : "rejeitada" === e.status ? "border-red-300 bg-red-50" : "border-yellow-300 bg-yellow-50")
        }, React.createElement("div", {
            className: "flex justify-between items-start"
        }, React.createElement("div", null, React.createElement("p", {
            className: "font-bold text-lg"
        }, e.indicado_nome), React.createElement("p", {
            className: "text-sm text-gray-600"
        }, "📞 ", e.indicado_contato), e.regiao && React.createElement("p", {
            className: "text-sm text-purple-600"
        }, "📍 ", e.regiao), e.valor_bonus && React.createElement("p", {
            className: "text-sm text-green-600 font-semibold"
        }, "💰 ", er(e.valor_bonus)), React.createElement("p", {
            className: "text-xs text-gray-500 mt-1"
        }, "Cadastrado em ", new Date(e.created_at).toLocaleDateString("pt-BR"))), React.createElement("div", {
            className: "text-right"
        }, React.createElement("span", {
            className: "inline-block px-3 py-1 rounded-full text-xs font-bold " + ("pendente" === e.status ? "bg-yellow-500 text-white" : "aprovada" === e.status ? "bg-green-500 text-white" : "bg-red-500 text-white")
        }, "pendente" === e.status ? "⏳ Pendente" : "aprovada" === e.status ? "✅ Aprovada" : "❌ Rejeitada"))), "aprovada" === e.status && React.createElement("div", {
            className: "mt-3 bg-green-100 border border-green-300 rounded-lg p-3"
        }, React.createElement("p", {
            className: "text-green-800 text-sm"
        }, "🎉 ", React.createElement("strong", null, "Parabéns!"), " Sua indicação foi aprovada! ", e.valor_bonus && `Bônus de ${er(e.valor_bonus)} será creditado.`)), "rejeitada" === e.status && e.motivo_rejeicao && React.createElement("div", {
            className: "mt-3 bg-red-100 border border-red-300 rounded-lg p-3"
        }, React.createElement("p", {
            className: "text-red-800 text-sm"
        }, React.createElement("strong", null, "Motivo:"), " ", e.motivo_rejeicao))))))), "promo-novatos" === p.userTab && React.createElement(React.Fragment, null, fe.ativo && !we && 0 === Ae && React.createElement("div", {
            className: "bg-gradient-to-r from-purple-600 to-purple-800 rounded-xl shadow-lg p-6 mb-6 text-white"
        }, React.createElement("div", {
            className: "text-center"
        }, React.createElement("div", {
            className: "text-5xl mb-4"
        }, "🎯"), React.createElement("h2", {
            className: "text-xl font-bold mb-2"
        }, fe.titulo), React.createElement("p", {
            className: "text-purple-200 mb-4"
        }, "Responda corretamente e ganhe gratuidade no seu próximo saque!"), React.createElement("div", {
            className: "bg-white/20 rounded-lg p-4 mb-4"
        }, React.createElement("p", {
            className: "text-2xl font-bold text-yellow-300"
        }, "💰 R$ ", fe.valor_gratuidade.toFixed(2).replace(".", ",")), React.createElement("p", {
            className: "text-sm text-purple-200"
        }, "de gratuidade se acertar tudo!")), React.createElement("button", {
            onClick: () => {
                Se(1), Pe(0)
            },
            className: "px-8 py-3 bg-yellow-400 text-purple-900 rounded-lg font-bold text-lg hover:bg-yellow-300"
        }, "🚀 Começar Quiz!"))), 1 === Ae && React.createElement("div", {
            className: "bg-white rounded-xl shadow-lg p-6 mb-6"
        }, React.createElement("div", {
            className: "text-center mb-4"
        }, React.createElement("h2", {
            className: "text-xl font-bold text-purple-700"
        }, "📸 Conheça os Procedimentos"), React.createElement("p", {
            className: "text-gray-500 text-sm"
        }, "Veja as imagens com atenção antes de responder"), React.createElement("p", {
            className: "text-purple-600 font-semibold mt-2"
        }, "Imagem ", ke + 1, " de 4")), React.createElement("div", {
            className: "relative bg-gray-100 rounded-xl overflow-hidden mb-4",
            style: {
                minHeight: "300px"
            }
        }, fe.imagens[ke] ? React.createElement("img", {
            src: fe.imagens[ke],
            alt: `Procedimento ${ke+1}`,
            className: "w-full h-full object-contain",
            style: {
                maxHeight: "400px"
            }
        }) : React.createElement("div", {
            className: "flex items-center justify-center h-64 text-gray-400"
        }, React.createElement("p", null, "Imagem não disponível"))), React.createElement("div", {
            className: "flex justify-center gap-2 mb-4"
        }, [0, 1, 2, 3].map(e => React.createElement("button", {
            key: e,
            onClick: () => Pe(e),
            className: "w-3 h-3 rounded-full transition " + (ke === e ? "bg-purple-600" : "bg-gray-300")
        }))), React.createElement("div", {
            className: "flex justify-between"
        }, React.createElement("button", {
            onClick: () => Pe(Math.max(0, ke - 1)),
            disabled: 0 === ke,
            className: "px-6 py-2 bg-gray-200 text-gray-700 rounded-lg font-semibold disabled:opacity-50"
        }, "← Anterior"), ke < 3 ? React.createElement("button", {
            onClick: () => Pe(ke + 1),
            className: "px-6 py-2 bg-purple-600 text-white rounded-lg font-semibold hover:bg-purple-700"
        }, "Próxima →") : React.createElement("button", {
            onClick: () => Se(2),
            className: "px-6 py-2 bg-green-600 text-white rounded-lg font-bold hover:bg-green-700"
        }, "✅ Ir para o Quiz!"))), 2 === Ae && React.createElement("div", {
            className: "bg-white rounded-xl shadow-lg p-6 mb-6"
        }, React.createElement("div", {
            className: "text-center mb-6"
        }, React.createElement("h2", {
            className: "text-xl font-bold text-purple-700"
        }, "❓ Responda: CERTO ou ERRADO?"), React.createElement("p", {
            className: "text-gray-500 text-sm"
        }, "Acerte as 5 afirmações para ganhar a gratuidade")), React.createElement("div", {
            className: "space-y-4 mb-6"
        }, fe.perguntas.map((e, t) => React.createElement("div", {
            key: t,
            className: "border-2 rounded-xl p-4 transition " + (null !== Te[t] ? "border-purple-300 bg-purple-50" : "border-gray-200")
        }, React.createElement("p", {
            className: "font-semibold text-gray-800 mb-3"
        }, React.createElement("span", {
            className: "text-purple-600"
        }, t + 1, "."), " ", e.texto), React.createElement("div", {
            className: "flex gap-3"
        }, React.createElement("button", {
            onClick: () => {
                const e = [...Te];
                e[t] = !0, De(e)
            },
            className: "flex-1 py-3 rounded-lg font-bold text-lg transition " + (!0 === Te[t] ? "bg-green-500 text-white" : "bg-green-100 text-green-700 hover:bg-green-200")
        }, "✓ CERTO"), React.createElement("button", {
            onClick: () => {
                const e = [...Te];
                e[t] = !1, De(e)
            },
            className: "flex-1 py-3 rounded-lg font-bold text-lg transition " + (!1 === Te[t] ? "bg-red-500 text-white" : "bg-red-100 text-red-700 hover:bg-red-200")
        }, "✗ ERRADO"))))), React.createElement("div", {
            className: "flex gap-3"
        }, React.createElement("button", {
            onClick: () => Se(1),
            className: "px-6 py-3 bg-gray-200 text-gray-700 rounded-lg font-semibold"
        }, "← Voltar às imagens"), React.createElement("button", {
            onClick: $l,
            disabled: c || Te.some(e => null === e),
            className: "flex-1 py-3 bg-purple-600 text-white rounded-lg font-bold text-lg hover:bg-purple-700 disabled:opacity-50"
        }, c ? "Enviando..." : "🎯 Enviar Respostas")), React.createElement("p", {
            className: "text-center text-xs text-gray-500 mt-3"
        }, "⚠️ Você tem apenas UMA chance de responder este quiz!")), 3 === Ae && Le && React.createElement("div", {
            className: `rounded-xl shadow-lg p-6 mb-6 text-center ${Le.passou?"bg-green-500":"bg-red-500"} text-white`
        }, React.createElement("div", {
            className: "text-6xl mb-4"
        }, Le.passou ? "🎉" : "😢"), React.createElement("h2", {
            className: "text-2xl font-bold mb-2"
        }, Le.passou ? "Parabéns! Você passou!" : "Que pena! Não foi dessa vez..."), React.createElement("p", {
            className: "text-lg mb-4"
        }, "Você acertou ", React.createElement("strong", null, Le.acertos), " de ", React.createElement("strong", null, "5"), " perguntas"), Le.passou && React.createElement("div", {
            className: "bg-white/20 rounded-lg p-4 mb-4"
        }, React.createElement("p", {
            className: "text-xl font-bold"
        }, "💰 R$ ", Le.valor_gratuidade.toFixed(2).replace(".", ",")), React.createElement("p", {
            className: "text-sm"
        }, "foi adicionado às suas gratuidades!")), React.createElement("button", {
            onClick: () => Se(0),
            className: "px-6 py-2 bg-white text-gray-800 rounded-lg font-semibold"
        }, "Fechar")), fe.ativo && we && 0 === Ae && React.createElement("div", {
            className: "bg-gray-100 border-2 border-gray-300 rounded-xl p-6 mb-6 text-center"
        }, React.createElement("div", {
            className: "text-4xl mb-2"
        }, "✅"), React.createElement("p", {
            className: "text-gray-600 font-semibold"
        }, "Você já participou do Quiz de Procedimentos"), React.createElement("p", {
            className: "text-gray-500 text-sm"
        }, "Esta promoção só pode ser usada uma vez")), React.createElement("hr", {
            className: "my-6 border-gray-200"
        }), React.createElement("div", {
            className: "bg-white rounded-xl shadow p-6 mb-6"
        }, React.createElement("h2", {
            className: "text-lg font-bold text-orange-700 mb-4"
        }, "🚀 Promoções Disponíveis para Novatos"), 0 === ce.length ? React.createElement("div", {
            className: "text-center py-8"
        }, React.createElement("p", {
            className: "text-6xl mb-4"
        }, "😕"), React.createElement("p", {
            className: "text-gray-500 font-semibold"
        }, "Nenhuma promoção disponível no momento"), React.createElement("p", {
            className: "text-gray-400 text-sm"
        }, "Volte mais tarde para verificar novas promoções")) : React.createElement("div", {
            className: "grid md:grid-cols-2 gap-4"
        }, ce.map(e => {
            const t = ie.some(t => t.promocao_id === e.id);
            return React.createElement("div", {
                key: e.id,
                className: "border-2 border-orange-200 bg-orange-50 rounded-xl p-4"
            }, React.createElement("div", {
                className: "flex justify-between items-start mb-2"
            }, React.createElement("div", null, React.createElement("p", {
                className: "text-sm text-gray-600"
            }, "📍 ", e.regiao), React.createElement("p", {
                className: "font-bold text-lg text-gray-800"
            }, "🏢 ", e.cliente)), React.createElement("span", {
                className: "px-3 py-1 bg-green-500 text-white rounded-full text-sm font-bold"
            }, er(e.valor_bonus))), e.detalhes && React.createElement("p", {
                className: "text-sm text-gray-600 mb-3 whitespace-pre-wrap"
            }, e.detalhes), React.createElement("div", {
                className: "bg-yellow-100 border border-yellow-300 rounded-lg p-2 mb-3"
            }, React.createElement("p", {
                className: "text-xs text-yellow-800"
            }, "⏱️ Ao se inscrever, você terá ", React.createElement("strong", null, "10 dias"), " para ser contemplado")), t ? React.createElement("button", {
                disabled: !0,
                className: "w-full py-2 bg-gray-300 text-gray-600 rounded-lg font-semibold cursor-not-allowed"
            }, "✅ Já inscrito") : React.createElement("button", {
                onClick: () => (async e => {
                    s(!0);
                    try {
                        const t = await fetch(`${API_URL}/inscricoes-novatos`, {
                            method: "POST",
                            headers: {
                                "Content-Type": "application/json"
                            },
                            body: JSON.stringify({
                                promocao_id: e.id,
                                user_cod: l.codProfissional,
                                user_name: l.fullName,
                                valor_bonus: e.valor_bonus,
                                regiao: e.regiao,
                                cliente: e.cliente
                            })
                        });
                        if (!t.ok) {
                            const e = await t.json();
                            throw new Error(e.error || "Erro ao se inscrever")
                        }
                        ja("✅ Inscrição realizada! Válida por 10 dias.", "success"), await kl(), await Al()
                    } catch (e) {
                        ja(e.message, "error")
                    } finally {
                        s(!1)
                    }
                })(e),
                disabled: c,
                className: "w-full py-2 bg-orange-500 text-white rounded-lg font-semibold hover:bg-orange-600 disabled:opacity-50"
            }, c ? "..." : "🚀 Quero me inscrever!"))
        }))), React.createElement("div", {
            className: "bg-white rounded-xl shadow p-6"
        }, React.createElement("h2", {
            className: "text-lg font-bold text-gray-800 mb-4"
        }, "📋 Minhas Inscrições e Bonificações"), je && React.createElement("div", {
            className: "border-2 rounded-xl p-4 mb-4 " + (je.passou ? "border-green-400 bg-green-50" : "border-red-300 bg-red-50")
        }, React.createElement("div", {
            className: "flex justify-between items-start"
        }, React.createElement("div", {
            className: "flex items-center gap-3"
        }, React.createElement("span", {
            className: "text-3xl"
        }, je.passou ? "🎉" : "📝"), React.createElement("div", null, React.createElement("p", {
            className: "font-bold text-gray-800"
        }, "Quiz de Procedimentos"), React.createElement("p", {
            className: "text-sm text-gray-600"
        }, "Respondido em: ", new Date(je.created_at).toLocaleDateString("pt-BR")), React.createElement("p", {
            className: "text-sm text-gray-500"
        }, "Acertos: ", je.acertos, "/5"))), React.createElement("div", {
            className: "text-right"
        }, je.passou && React.createElement("p", {
            className: "font-bold text-green-600 text-lg"
        }, er(fe.valor_gratuidade)), React.createElement("span", {
            className: "inline-block mt-1 px-3 py-1 rounded-full text-xs font-bold " + (je.passou ? "bg-green-500 text-white" : "bg-red-400 text-white")
        }, je.passou ? "✅ Aprovado" : "❌ Não passou"))), je.passou && React.createElement("div", {
            className: "mt-3 bg-green-100 border border-green-300 rounded-lg p-3"
        }, React.createElement("p", {
            className: "text-green-800 text-sm"
        }, "🎉 ", React.createElement("strong", null, "Parabéns!"), " Você acertou todas as perguntas! A gratuidade de ", er(fe.valor_gratuidade), " foi adicionada à sua conta.")), !je.passou && React.createElement("div", {
            className: "mt-3 bg-red-100 border border-red-300 rounded-lg p-3"
        }, React.createElement("p", {
            className: "text-red-800 text-sm"
        }, "😢 Infelizmente você não acertou todas as perguntas. Era necessário acertar 5/5 para ganhar a gratuidade."))), 0 !== ie.length || je ? React.createElement("div", {
            className: "space-y-3"
        }, ie.map(e => {
            const t = e.expires_at ? new Date(e.expires_at) : null,
                a = t && new Date > t;
            return React.createElement("div", {
                key: e.id,
                className: "border rounded-lg p-4 " + ("aprovada" === e.status ? "border-green-300 bg-green-50" : "rejeitada" === e.status ? "border-red-300 bg-red-50" : a ? "border-gray-300 bg-gray-50" : "border-yellow-300 bg-yellow-50")
            }, React.createElement("div", {
                className: "flex justify-between items-start"
            }, React.createElement("div", null, React.createElement("p", {
                className: "font-semibold text-gray-800"
            }, "🏢 ", e.cliente), React.createElement("p", {
                className: "text-sm text-gray-600"
            }, "📍 ", e.regiao), React.createElement("p", {
                className: "text-sm text-gray-500"
            }, "Inscrito em: ", new Date(e.created_at).toLocaleDateString("pt-BR")), t && "pendente" === e.status && !a && React.createElement("p", {
                className: "text-xs text-orange-600"
            }, "⏱️ Expira em: ", t.toLocaleDateString("pt-BR"))), React.createElement("div", {
                className: "text-right"
            }, React.createElement("p", {
                className: "font-bold text-green-600"
            }, er(e.valor_bonus)), React.createElement("span", {
                className: "inline-block mt-1 px-2 py-1 rounded-full text-xs font-bold " + ("pendente" !== e.status || a ? "aprovada" === e.status ? "bg-green-200 text-green-800" : "rejeitada" === e.status ? "bg-red-200 text-red-800" : "bg-gray-200 text-gray-800" : "bg-yellow-200 text-yellow-800")
            }, "pendente" === e.status && a ? "⏰ Expirada" : "pendente" === e.status ? "⏳ Pendente" : "aprovada" === e.status ? "✅ Aprovada" : "rejeitada" === e.status ? "❌ Rejeitada" : e.status))), "aprovada" === e.status && React.createElement("div", {
                className: "mt-3 bg-green-100 border border-green-300 rounded-lg p-3"
            }, React.createElement("p", {
                className: "text-green-800 text-sm"
            }, "🎉 ", React.createElement("strong", null, "Parabéns!"), " Você foi contemplado! O bônus de ", er(e.valor_bonus), " será incluído no seu próximo repasse.")), "rejeitada" === e.status && e.motivo_rejeicao && React.createElement("div", {
                className: "mt-3 bg-red-100 border border-red-300 rounded-lg p-3"
            }, React.createElement("p", {
                className: "text-red-800 text-sm"
            }, React.createElement("strong", null, "Motivo:"), " ", e.motivo_rejeicao)))
        })) : React.createElement("p", {
            className: "text-gray-500 text-center py-4"
        }, "Você ainda não participou de nenhuma promoção"))), "seguro-iza" === p.userTab && React.createElement("div", {
            className: "max-w-lg mx-auto"
        }, React.createElement("div", {
            className: "bg-gradient-to-b from-sky-100 to-white rounded-2xl shadow-xl overflow-hidden"
        }, React.createElement("div", {
            className: "bg-gradient-to-r from-blue-600 to-blue-700 text-white text-center py-4 px-4"
        }, React.createElement("h2", {
            className: "text-xl font-bold tracking-wide"
        }, "🛡️ SEGURO DE VIDA PARA"), React.createElement("h2", {
            className: "text-xl font-bold tracking-wide"
        }, "ENTREGADORES TUTTS")), React.createElement("div", {
            className: "p-4 space-y-4"
        }, React.createElement("div", {
            className: "bg-white rounded-xl shadow border-l-4 border-yellow-400 overflow-hidden"
        }, React.createElement("div", {
            className: "bg-yellow-400 text-yellow-900 font-bold text-center py-2 text-sm italic"
        }, "QUANDO ESTÁ ATIVO?"), React.createElement("div", {
            className: "p-4 space-y-2 text-sm text-gray-700"
        }, React.createElement("p", null, "🕐 Durante a entrega (aceite à finalização)"), React.createElement("p", null, "⏳ ", React.createElement("strong", null, "Limite:"), " 60 min por entrega (encerra após)"), React.createElement("p", null, "❌ ", React.createElement("strong", null, "Não cobre:"), " Trajeto casa/pessoal"))), React.createElement("div", {
            className: "bg-white rounded-xl shadow border-l-4 border-green-500 overflow-hidden"
        }, React.createElement("div", {
            className: "bg-green-500 text-white font-bold text-center py-2 text-sm"
        }, "COBERTURAS E VALORES"), React.createElement("div", {
            className: "p-4 space-y-2 text-sm text-gray-700"
        }, React.createElement("p", null, "☠️ ", React.createElement("strong", null, "Morte Acidental:"), " R$ 20.000"), React.createElement("p", null, "💰 ", React.createElement("strong", null, "Invalidez Perm.:"), " R$ 20.000"), React.createElement("p", null, "🏥 ", React.createElement("strong", null, "Desp. Médicas/Hosp.:"), " Até R$ 5.000"), React.createElement("p", null, "📅 ", React.createElement("strong", null, "Diária Incapacidade:"), " R$ 80/dia (30 dias)"), React.createElement("p", null, "⚰️ ", React.createElement("strong", null, "Funeral:"), " R$ 5.000"))), React.createElement("div", {
            className: "bg-white rounded-xl shadow border-l-4 border-red-500 overflow-hidden"
        }, React.createElement("div", {
            className: "bg-red-500 text-white font-bold text-center py-2 text-sm"
        }, "QUANDO NÃO COBRE?"), React.createElement("div", {
            className: "p-4 space-y-2 text-sm text-gray-700"
        }, React.createElement("p", null, "⚠️ Cadastro/CPF incorreto"), React.createElement("p", null, "⚠️ Sem CNH válida"), React.createElement("p", null, "⚠️ Veículo errado"), React.createElement("p", null, "⚠️ Fora de entrega ativa"), React.createElement("p", null, "⚠️ Fraude/Má-fé"))), React.createElement("div", {
            className: "bg-white rounded-xl shadow border-l-4 border-gray-500 overflow-hidden"
        }, React.createElement("div", {
            className: "bg-gray-600 text-white font-bold text-center py-2 text-sm"
        }, "COMO ACIONAR? (IZA Seguros)"), React.createElement("div", {
            className: "p-4 space-y-2 text-sm text-gray-700"
        }, React.createElement("p", null, "📱 ", React.createElement("strong", null, "Baixar"), " App IZA"), React.createElement("p", null, "📋 ", React.createElement("strong", null, "Informar"), " Data/Hora/Local"), React.createElement("p", null, "📄 ", React.createElement("strong", null, "Anexar Documentos"), " (B.O., atestado)"), React.createElement("p", null, "📞 ", React.createElement("strong", null, "Suporte:"), " Tel (11) 4673-2002"), React.createElement("p", null, "💬 ", React.createElement("strong", null, "WhatsApp:"), " ", React.createElement("a", {
            href: "https://wa.me/551146732004",
            target: "_blank",
            rel: "noopener noreferrer",
            className: "text-green-600 font-bold underline hover:text-green-700"
        }, "(11) 4673-2004")), React.createElement("p", null, "🌐 ", React.createElement("strong", null, "Site:"), " ", React.createElement("a", {
            href: "https://www.iza.com.vc",
            target: "_blank",
            rel: "noopener noreferrer",
            className: "text-blue-600 underline hover:text-blue-700"
        }, "www.iza.com.vc")))), React.createElement("div", {
            className: "bg-white rounded-xl shadow border-l-4 border-orange-400 overflow-hidden"
        }, React.createElement("div", {
            className: "bg-orange-400 text-white font-bold text-center py-2 text-sm"
        }, "OUTRAS INFORMAÇÕES"), React.createElement("div", {
            className: "p-4 space-y-2 text-sm text-gray-700"
        }, React.createElement("p", null, "ℹ️ ", React.createElement("strong", null, "Sem carência"), " (desde 1ª entrega)"), React.createElement("p", null, "ℹ️ ", React.createElement("strong", null, "Renova"), " a cada entrega aceita"))), React.createElement("button", {
            onClick: () => x({
                ...p,
                seguroDetalhes: !p.seguroDetalhes
            }),
            className: "w-full py-3 bg-blue-600 text-white rounded-xl font-bold hover:bg-blue-700 transition-all flex items-center justify-center gap-2"
        }, "📄 ", p.seguroDetalhes ? "Ocultar Detalhes" : "Ver Texto com Mais Detalhes"), p.seguroDetalhes && React.createElement("div", {
            className: "bg-white rounded-xl shadow p-4 text-sm text-gray-700 space-y-4 border border-blue-200"
        }, React.createElement("h3", {
            className: "font-bold text-blue-800 text-lg"
        }, "📋 Informações Completas do Seguro"), React.createElement("div", null, React.createElement("h4", {
            className: "font-bold text-gray-800 mb-2"
        }, "Quando o seguro está ativo?"), React.createElement("ul", {
            className: "list-disc pl-5 space-y-1"
        }, React.createElement("li", null, "O seguro cobre você durante o período em que estiver realizando uma entrega pela plataforma da Tutts."), React.createElement("li", null, "A cobertura é ativada automaticamente desde o aceite da entrega até a finalização no destino."), React.createElement("li", null, "Não cobre o trajeto de casa para o trabalho ou atividades pessoais."), React.createElement("li", null, "O entregador estará coberto durante o período da entrega, limitado a até 60 minutos. Ou seja, se a entrega ultrapassar esse tempo e for finalizada após os 60 minutos, a cobertura do seguro de vida será encerrada."))), React.createElement("div", null, React.createElement("h4", {
            className: "font-bold text-gray-800 mb-2"
        }, "Coberturas e Valores"), React.createElement("ul", {
            className: "list-disc pl-5 space-y-1"
        }, React.createElement("li", null, React.createElement("strong", null, "Morte Acidental:"), " R$ 20.000,00"), React.createElement("li", null, React.createElement("strong", null, "Invalidez Permanente Total ou Parcial por Acidente:"), " R$ 20.000,00"), React.createElement("li", null, React.createElement("strong", null, "Despesas Médicas, Hospitalares e Odontológicos:"), " Até R$ 5.000,00"), React.createElement("li", null, React.createElement("strong", null, "Diária por Incapacidade Temporária (até 30 dias):"), " R$ 80,00 por dia"), React.createElement("li", null, React.createElement("strong", null, "Funeral:"), " R$ 5.000,00"))), React.createElement("div", null, React.createElement("h4", {
            className: "font-bold text-gray-800 mb-2"
        }, "Quando o seguro não cobre?"), React.createElement("ul", {
            className: "list-disc pl-5 space-y-1"
        }, React.createElement("li", null, "Se o entregador não estiver cadastrado corretamente ou com CPF incorreto."), React.createElement("li", null, "Se estiver sem habilitação válida no momento do acidente."), React.createElement("li", null, "Se estiver usando o veículo errado (ex.: moto em contrato de carro)."), React.createElement("li", null, "Se estiver fora de uma entrega ativa pela plataforma da Tutts."), React.createElement("li", null, "Se for constatado fraude ou má-fé."))), React.createElement("div", null, React.createElement("h4", {
            className: "font-bold text-gray-800 mb-2"
        }, "Como acionar o seguro em caso de acidente?"), React.createElement("ul", {
            className: "list-disc pl-5 space-y-1"
        }, React.createElement("li", null, "Baixe o aplicativo IZA Seguros."), React.createElement("li", null, "Informe: data, horário e local do acidente."), React.createElement("li", null, "Anexe os documentos solicitados no app (como boletim de ocorrência ou atestado médico)."), React.createElement("li", null, "Dúvidas ou suporte: Telefone (11) 4673-2002 | WhatsApp", " ", React.createElement("a", {
            href: "https://wa.me/551146732004",
            target: "_blank",
            rel: "noopener noreferrer",
            className: "text-green-600 font-bold underline"
        }, "(11) 4673-2004")), React.createElement("li", null, "Site:", " ", React.createElement("a", {
            href: "https://www.iza.com.vc",
            target: "_blank",
            rel: "noopener noreferrer",
            className: "text-blue-600 underline"
        }, "www.iza.com.vc")))), React.createElement("div", null, React.createElement("h4", {
            className: "font-bold text-gray-800 mb-2"
        }, "Outras Informações"), React.createElement("ul", {
            className: "list-disc pl-5 space-y-1"
        }, React.createElement("li", null, React.createElement("strong", null, "Sem carência:"), " você estará coberto a partir da primeira entrega feita no dia."), React.createElement("li", null, "A cobertura se renova a cada entrega aceita na plataforma da Tutts."))))))), "loja" === p.userTab && React.createElement(React.Fragment, null, rt && React.createElement("div", {
            className: "fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4"
        }, React.createElement("div", {
            className: "bg-white rounded-3xl shadow-2xl max-w-md w-full overflow-hidden"
        }, React.createElement("div", {
            className: "bg-gradient-to-r from-purple-600 to-pink-500 p-6 text-center"
        }, React.createElement("div", {
            className: "text-6xl mb-2"
        }, "🛒✨"), React.createElement("h2", {
            className: "text-2xl font-bold text-white"
        }, "Lojinha Virtual da Tutts")), React.createElement("div", {
            className: "p-6"
        }, React.createElement("p", {
            className: "text-lg mb-4"
        }, React.createElement("span", {
            className: "text-2xl"
        }, "👋"), " ", React.createElement("strong", null, "Olá, entregador!")), React.createElement("p", {
            className: "text-gray-700 mb-4"
        }, "Criamos este espaço para trazer mais ", React.createElement("strong", null, "praticidade"), " e ", React.createElement("strong", null, "acessibilidade"), " na compra de itens essenciais para o seu dia a dia."), React.createElement("p", {
            className: "text-gray-700 mb-4"
        }, "As ofertas disponíveis aqui são ", React.createElement("strong", null, "exclusivas"), " para você, entregador autônomo que opera ativamente no aplicativo Tutts há pelo menos 3 meses e possui um bom score ⭐📊"), React.createElement("p", {
            className: "text-gray-700 mb-2"
        }, "Aproveite os benefícios, equipe sua rotina com qualidade e economize! 💜"), React.createElement("div", {
            className: "bg-purple-50 rounded-xl p-4 mb-6"
        }, React.createElement("p", {
            className: "text-purple-800 font-semibold text-center"
        }, "💰 Abatimentos diretamente do saldo do aplicativo!")), React.createElement("div", {
            className: "relative"
        }, React.createElement("p", {
            className: "text-sm text-gray-500 text-center mb-2"
        }, "Deslize para concordar e avançar"), React.createElement("div", {
            className: "relative h-16 bg-gray-100 rounded-full overflow-hidden border-2 border-gray-200"
        }, React.createElement("div", {
            className: "absolute left-0 top-0 h-full bg-gradient-to-r from-purple-500 to-pink-500 rounded-full",
            style: {
                width: `${ct}%`,
                transition: "width 0.1s ease-out"
            }
        }), React.createElement("input", {
            type: "range",
            min: "0",
            max: "100",
            value: ct,
            onChange: e => {
                const t = parseInt(e.target.value);
                st(t)
            },
            onMouseUp: () => {
                ct >= 85 ? (st(100), setTimeout(() => ot(!1), 300)) : st(0)
            },
            onTouchEnd: () => {
                ct >= 85 ? (st(100), setTimeout(() => ot(!1), 300)) : st(0)
            },
            className: "absolute inset-0 w-full h-full opacity-0 cursor-pointer z-20",
            style: {
                WebkitAppearance: "none",
                margin: 0
            }
        }), React.createElement("div", {
            className: "absolute top-1/2 -translate-y-1/2 h-12 w-12 bg-white rounded-full shadow-lg flex items-center justify-center text-2xl pointer-events-none z-10 border-2 border-purple-200",
            style: {
                left: `calc(${Math.min(ct,92)}% - ${.4*ct}px + 4px)`,
                transition: "left 0.1s ease-out"
            }
        }, ct >= 85 ? "✅" : "👆"), React.createElement("div", {
            className: "absolute inset-0 flex items-center justify-center pointer-events-none"
        }, React.createElement("span", {
            className: "font-bold text-sm " + (ct > 30 ? "text-white" : "text-gray-400")
        }, ct >= 85 ? "Entrando..." : ct > 10 ? "Continue →" : "Arraste para entrar →"))), React.createElement("p", {
            className: "text-xs text-gray-400 text-center mt-2"
        }, "Solte no final para confirmar"))))), !rt && React.createElement("div", {
            className: "space-y-6"
        }, React.createElement("div", {
            className: "bg-gradient-to-r from-purple-600 to-pink-500 rounded-2xl p-6 text-white text-center"
        }, React.createElement("h2", {
            className: "text-2xl font-bold mb-2"
        }, "🛍️ Ofertas Exclusivas!"), React.createElement("p", {
            className: "text-white/80"
        }, "Abatimento direto no seu saldo - Sem dor de cabeça!")), React.createElement("button", {
            onClick: () => x({
                ...p,
                lojaSugestaoModal: !0
            }),
            className: "w-full py-3 bg-gradient-to-r from-amber-500 to-orange-500 text-white rounded-xl font-semibold hover:opacity-90 transition-opacity shadow-lg flex items-center justify-center gap-2"
        }, "💡 Sugerir Produto para a Loja"), bt.length > 0 && React.createElement("div", {
            className: "bg-white rounded-xl shadow p-4"
        }, React.createElement("h3", {
            className: "font-bold text-gray-800 mb-3"
        }, "💡 Minhas Sugestões"), React.createElement("div", {
            className: "space-y-2"
        }, bt.map(e => React.createElement("div", {
            key: e.id,
            className: "p-3 rounded-lg border " + ("respondido" === e.status ? "border-green-200 bg-green-50" : "recusado" === e.status ? "border-red-200 bg-red-50" : "border-gray-200 bg-gray-50")
        }, React.createElement("p", {
            className: "text-sm text-gray-800"
        }, e.sugestao), React.createElement("p", {
            className: "text-xs text-gray-500 mt-1"
        }, new Date(e.created_at).toLocaleDateString("pt-BR")), "respondido" === e.status && e.resposta && React.createElement("div", {
            className: "mt-2 p-2 bg-green-100 rounded"
        }, React.createElement("p", {
            className: "text-xs font-semibold text-green-800"
        }, "✅ Resposta:"), React.createElement("p", {
            className: "text-sm text-green-700"
        }, e.resposta)), "recusado" === e.status && e.resposta && React.createElement("div", {
            className: "mt-2 p-2 bg-red-100 rounded"
        }, React.createElement("p", {
            className: "text-xs font-semibold text-red-800"
        }, "❌ Resposta:"), React.createElement("p", {
            className: "text-sm text-red-700"
        }, e.resposta)), "pendente" === e.status && React.createElement("span", {
            className: "inline-block mt-2 px-2 py-0.5 bg-yellow-100 text-yellow-700 text-xs rounded-full"
        }, "⏳ Aguardando análise"))))), p.lojaSugestaoModal && React.createElement("div", {
            className: "fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4"
        }, React.createElement("div", {
            className: "bg-white rounded-2xl shadow-2xl max-w-md w-full"
        }, React.createElement("div", {
            className: "bg-gradient-to-r from-amber-500 to-orange-500 p-4 rounded-t-2xl text-white"
        }, React.createElement("h2", {
            className: "text-xl font-bold"
        }, "💡 Sugerir Produto"), React.createElement("p", {
            className: "text-sm opacity-80"
        }, "Diga o que você gostaria de ver na loja")), React.createElement("div", {
            className: "p-6"
        }, React.createElement("textarea", {
            value: p.lojaSugestaoTexto || "",
            onChange: e => x({
                ...p,
                lojaSugestaoTexto: e.target.value
            }),
            placeholder: "Descreva o produto que você gostaria que tivesse na loja... Ex: Tênis Nike Air Max tamanho 42, Camiseta do Flamengo M...",
            className: "w-full px-4 py-3 border rounded-xl h-32 resize-none"
        }), React.createElement("p", {
            className: "text-xs text-gray-500 mt-2"
        }, "Sua sugestão será analisada pela equipe"), React.createElement("div", {
            className: "flex gap-3 mt-4"
        }, React.createElement("button", {
            onClick: () => x({
                ...p,
                lojaSugestaoModal: !1,
                lojaSugestaoTexto: ""
            }),
            className: "flex-1 px-4 py-2 bg-gray-200 text-gray-700 rounded-lg font-semibold"
        }, "Cancelar"), React.createElement("button", {
            onClick: async () => {
                p.lojaSugestaoTexto?.trim() ? (await fetch(`${API_URL}/loja/sugestoes`, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({
                        user_cod: l.codProfissional,
                        user_name: l.fullName,
                        sugestao: p.lojaSugestaoTexto.trim()
                    })
                }), ja("💡 Sugestão enviada!", "success"), x({
                    ...p,
                    lojaSugestaoModal: !1,
                    lojaSugestaoTexto: ""
                }), Ka()) : ja("Digite sua sugestão", "error")
            },
            className: "flex-1 px-4 py-2 bg-gradient-to-r from-amber-500 to-orange-500 text-white rounded-lg font-semibold hover:opacity-90"
        }, "📤 Enviar Sugestão"))))), at.length > 0 && React.createElement("div", {
            className: "bg-white rounded-xl shadow p-4"
        }, React.createElement("h3", {
            className: "font-bold text-gray-800 mb-3"
        }, "📦 Meus Pedidos"), React.createElement("div", {
            className: "space-y-3"
        }, at.map(e => React.createElement("div", {
            key: e.id,
            className: "p-4 rounded-xl border-2 " + ("aprovado" === e.status ? "border-green-200 bg-green-50" : "rejeitado" === e.status ? "border-red-200 bg-red-50" : "border-gray-200 bg-gray-50")
        }, React.createElement("div", {
            className: "flex justify-between items-start"
        }, React.createElement("div", {
            className: "flex-1"
        }, React.createElement("p", {
            className: "font-bold text-gray-800"
        }, e.produto_nome), e.tamanho && React.createElement("p", {
            className: "text-sm text-purple-600"
        }, "Tamanho: ", e.tamanho), React.createElement("p", {
            className: "text-xs text-gray-500 mt-1"
        }, new Date(e.created_at).toLocaleDateString("pt-BR"), " • ", e.tipo_abatimento), React.createElement("p", {
            className: "font-bold text-green-600 mt-1"
        }, "R$ ", parseFloat(e.valor_final).toFixed(2).replace(".", ","), e.parcelas > 1 && React.createElement("span", {
            className: "text-xs font-normal text-gray-500"
        }, " (", e.parcelas, "x)"))), React.createElement("span", {
            className: "px-3 py-1 rounded-full text-xs font-bold " + ("pendente" === e.status ? "bg-yellow-100 text-yellow-700" : "aprovado" === e.status ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700")
        }, "pendente" === e.status ? "⏳ Aguardando" : "aprovado" === e.status ? "✅ Aprovado" : "❌ Rejeitado")), "aprovado" === e.status && React.createElement("div", {
            className: "mt-3 p-3 bg-green-100 rounded-lg"
        }, React.createElement("p", {
            className: "text-green-800 text-sm font-semibold"
        }, "✅ Pedido Aprovado!"), React.createElement("p", {
            className: "text-green-700 text-xs mt-1"
        }, "Logo mais, um responsável entrará em contato para realizar a entrega do produto adquirido.")), "rejeitado" === e.status && React.createElement("div", {
            className: "mt-3 p-3 bg-red-100 rounded-lg"
        }, React.createElement("p", {
            className: "text-red-800 text-sm font-semibold"
        }, "❌ Pedido Não Aprovado"), e.observacao && React.createElement("p", {
            className: "text-red-700 text-xs mt-1"
        }, React.createElement("span", {
            className: "font-semibold"
        }, "Motivo:"), " ", e.observacao)))))), React.createElement("div", {
            className: "grid gap-4"
        }, 0 === Ke.length ? React.createElement("div", {
            className: "bg-white rounded-xl shadow p-8 text-center"
        }, React.createElement("div", {
            className: "text-6xl mb-4"
        }, "🏪"), React.createElement("p", {
            className: "text-gray-500"
        }, "Nenhum produto disponível no momento"), React.createElement("p", {
            className: "text-sm text-gray-400 mt-2"
        }, "Em breve teremos novidades!")) : Ke.map(e => React.createElement("div", {
            key: e.id,
            className: "bg-white rounded-xl shadow-lg overflow-hidden hover:shadow-xl transition-shadow"
        }, e.imagem_url && React.createElement("div", {
            className: "relative cursor-pointer group bg-gray-100",
            onClick: () => x({
                ...p,
                lojaImagemAmpliada: e.imagem_url
            })
        }, React.createElement("img", {
            src: e.imagem_url,
            alt: e.nome,
            className: "w-full h-64 object-contain group-hover:opacity-90 transition-opacity"
        }), React.createElement("div", {
            className: "absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity bg-black/20"
        }, React.createElement("span", {
            className: "bg-white/90 text-gray-700 px-3 py-1 rounded-full text-sm font-semibold"
        }, "🔍 Ampliar"))), React.createElement("div", {
            className: "p-4"
        }, React.createElement("h3", {
            className: "font-bold text-gray-800 text-lg"
        }, e.nome), e.marca && React.createElement("p", {
            className: "text-sm text-purple-600 font-medium"
        }, e.marca), e.descricao && React.createElement("p", {
            className: "text-sm text-gray-600 mt-1 line-clamp-2"
        }, e.descricao), React.createElement("div", {
            className: "mt-3 p-3 bg-gray-50 rounded-lg"
        }, React.createElement("div", {
            className: "flex items-baseline justify-between"
        }, React.createElement("span", {
            className: "text-2xl font-bold text-green-600"
        }, "R$ ", parseFloat(e.valor).toFixed(2).replace(".", ","))), e.parcelas_config && e.parcelas_config.filter(e => e && parseFloat(e.valor_parcela) > 0).length > 0 && React.createElement("div", {
            className: "mt-2 flex flex-wrap gap-1"
        }, e.parcelas_config.filter(e => e && parseFloat(e.valor_parcela) > 0).map((e, t) => React.createElement("span", {
            key: t,
            className: "text-xs bg-purple-100 text-purple-700 px-2 py-1 rounded-full"
        }, 1 === parseInt(e.parcelas) ? "À vista" : `${e.parcelas}x`, " R$ ", parseFloat(e.valor_parcela).toFixed(2).replace(".", ","))))), React.createElement("button", {
            onClick: () => x({
                ...p,
                lojaProdutoSelecionado: e,
                lojaCompraModal: !0
            }),
            className: "mt-3 w-full py-3 bg-gradient-to-r from-purple-600 to-pink-500 text-white rounded-xl font-bold text-lg hover:opacity-90 transition-opacity shadow-lg"
        }, "🛒 Comprar"))))), p.lojaImagemAmpliada && React.createElement("div", {
            className: "fixed inset-0 bg-black/90 z-50 flex items-center justify-center p-4",
            onClick: () => x({
                ...p,
                lojaImagemAmpliada: null
            })
        }, React.createElement("button", {
            className: "absolute top-4 right-4 text-white text-4xl hover:text-gray-300",
            onClick: () => x({
                ...p,
                lojaImagemAmpliada: null
            })
        }, "✕"), React.createElement("img", {
            src: p.lojaImagemAmpliada,
            alt: "Imagem ampliada",
            className: "max-w-full max-h-full object-contain rounded-lg"
        }))), p.lojaCompraModal && p.lojaProdutoSelecionado && React.createElement("div", {
            className: "fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4"
        }, React.createElement("div", {
            className: "bg-white rounded-2xl shadow-2xl max-w-md w-full max-h-[90vh] overflow-y-auto"
        }, React.createElement("div", {
            className: "bg-gradient-to-r from-purple-600 to-pink-500 p-4 text-white"
        }, React.createElement("h2", {
            className: "text-xl font-bold"
        }, "🛒 Finalizar Compra")), React.createElement("div", {
            className: "p-6"
        }, React.createElement("div", {
            className: "flex gap-4 mb-6"
        }, p.lojaProdutoSelecionado.imagem_url && React.createElement("img", {
            src: p.lojaProdutoSelecionado.imagem_url,
            alt: "",
            className: "w-24 h-24 object-cover rounded-lg"
        }), React.createElement("div", null, React.createElement("h3", {
            className: "font-bold text-gray-800"
        }, p.lojaProdutoSelecionado.nome), p.lojaProdutoSelecionado.marca && React.createElement("p", {
            className: "text-sm text-gray-500"
        }, p.lojaProdutoSelecionado.marca), React.createElement("p", {
            className: "text-xl font-bold text-green-600 mt-1"
        }, "R$ ", parseFloat(p.lojaProdutoSelecionado.valor).toFixed(2).replace(".", ",")))), p.lojaProdutoSelecionado.tem_tamanho && p.lojaProdutoSelecionado.tamanhos && p.lojaProdutoSelecionado.tamanhos.length > 0 && React.createElement("div", {
            className: "mb-4"
        }, React.createElement("label", {
            className: "block text-sm font-semibold mb-2"
        }, "Tamanho *"), React.createElement("div", {
            className: "flex flex-wrap gap-2"
        }, p.lojaProdutoSelecionado.tamanhos.map(e => React.createElement("button", {
            key: e.tamanho,
            onClick: () => x({
                ...p,
                lojaCompraTamanho: e.tamanho
            }),
            disabled: e.quantidade <= 0,
            className: "px-4 py-2 rounded-lg border-2 font-semibold transition-all " + (p.lojaCompraTamanho === e.tamanho ? "border-purple-600 bg-purple-50 text-purple-700" : e.quantidade <= 0 ? "border-gray-200 bg-gray-100 text-gray-400 cursor-not-allowed" : "border-gray-300 hover:border-purple-400")
        }, e.tamanho, e.quantidade <= 0 && React.createElement("span", {
            className: "text-xs ml-1"
        }, "(Esgotado)"))))), React.createElement("div", {
            className: "mb-6"
        }, React.createElement("label", {
            className: "block text-sm font-semibold mb-2"
        }, "Forma de Pagamento *"), React.createElement("div", {
            className: "space-y-2"
        }, (() => {
            const e = (p.lojaProdutoSelecionado.parcelas_config || []).filter(e => e && parseFloat(e.valor_parcela) > 0);
            return 0 === e.length ? React.createElement("div", {
                className: "text-center py-4 text-gray-500"
            }, React.createElement("p", null, "Nenhuma opção de pagamento configurada"), React.createElement("p", {
                className: "text-xs mt-1"
            }, "Entre em contato com o administrador")) : e.map((e, t) => {
                const a = parseInt(e.parcelas) || 1,
                    l = parseFloat(e.valor_parcela) || 0,
                    r = l * a,
                    o = parseFloat(p.lojaProdutoSelecionado.valor) - r,
                    c = 1 === a ? "À Vista" : `${a}x Semanal`;
                return React.createElement("button", {
                    key: t,
                    onClick: () => x({
                        ...p,
                        lojaCompraTipo: c,
                        lojaCompraParcelas: a,
                        lojaCompraValorFinal: r,
                        lojaCompraValorParcela: l,
                        lojaCompraDesconto: o > 0 ? o : 0
                    }),
                    className: "w-full p-4 rounded-xl border-2 text-left transition-all " + (p.lojaCompraTipo === c ? "border-purple-600 bg-purple-50" : "border-gray-200 hover:border-purple-300")
                }, React.createElement("div", {
                    className: "flex justify-between items-center"
                }, React.createElement("div", null, React.createElement("p", {
                    className: "font-semibold"
                }, c), React.createElement("p", {
                    className: "text-xs text-gray-500"
                }, 1 === a ? "Abatimento único do saldo" : `${a} abatimentos semanais`)), React.createElement("div", {
                    className: "text-right"
                }, o > 0 && React.createElement("p", {
                    className: "text-xs text-green-600 font-semibold"
                }, "Economia R$ ", o.toFixed(2).replace(".", ",")), React.createElement("p", {
                    className: "font-bold text-purple-700"
                }, a > 1 ? `${a}x de ` : "", "R$ ", l.toFixed(2).replace(".", ",")), a > 1 && React.createElement("p", {
                    className: "text-xs text-gray-500"
                }, "Total: R$ ", r.toFixed(2).replace(".", ",")))))
            })
        })())), p.lojaCompraTipo && React.createElement("div", {
            className: "bg-gray-50 rounded-xl p-4 mb-6"
        }, React.createElement("h4", {
            className: "font-bold text-gray-800 mb-2"
        }, "📋 Resumo do Pedido"), React.createElement("div", {
            className: "space-y-1 text-sm"
        }, React.createElement("div", {
            className: "flex justify-between"
        }, React.createElement("span", {
            className: "text-gray-600"
        }, "Valor original:"), React.createElement("span", null, "R$ ", parseFloat(p.lojaProdutoSelecionado.valor).toFixed(2).replace(".", ","))), p.lojaCompraDesconto > 0 && React.createElement("div", {
            className: "flex justify-between text-green-600"
        }, React.createElement("span", null, "Desconto:"), React.createElement("span", null, "- R$ ", p.lojaCompraDesconto.toFixed(2).replace(".", ","))), React.createElement("div", {
            className: "flex justify-between font-bold text-lg border-t pt-2 mt-2"
        }, React.createElement("span", null, "Total:"), React.createElement("span", {
            className: "text-purple-700"
        }, "R$ ", p.lojaCompraValorFinal.toFixed(2).replace(".", ","))), p.lojaCompraParcelas > 1 && React.createElement("p", {
            className: "text-center text-xs text-gray-500 mt-1"
        }, "em ", p.lojaCompraParcelas, "x de R$ ", p.lojaCompraValorParcela.toFixed(2).replace(".", ",")))), React.createElement("div", {
            className: "flex gap-3"
        }, React.createElement("button", {
            onClick: () => x({
                ...p,
                lojaCompraModal: !1,
                lojaProdutoSelecionado: null,
                lojaCompraTipo: null,
                lojaCompraTamanho: null
            }),
            className: "flex-1 px-4 py-3 bg-gray-200 text-gray-700 rounded-xl font-semibold"
        }, "Cancelar"), React.createElement("button", {
            onClick: async () => {
                if (!p.lojaProdutoSelecionado.tem_tamanho || p.lojaCompraTamanho)
                    if (p.lojaCompraTipo) try {
                        const e = {
                            produto_id: p.lojaProdutoSelecionado.id,
                            user_cod: l.codProfissional,
                            user_name: l.fullName,
                            produto_nome: p.lojaProdutoSelecionado.nome,
                            tamanho: p.lojaCompraTamanho || null,
                            marca: p.lojaProdutoSelecionado.marca || null,
                            valor_original: parseFloat(p.lojaProdutoSelecionado.valor),
                            tipo_abatimento: p.lojaCompraTipo,
                            valor_abatimento: p.lojaCompraDesconto || 0,
                            valor_final: p.lojaCompraValorFinal,
                            parcelas: p.lojaCompraParcelas,
                            valor_parcela: p.lojaCompraValorParcela
                        };
                        await fetch(`${API_URL}/loja/pedidos`, {
                            method: "POST",
                            headers: {
                                "Content-Type": "application/json"
                            },
                            body: JSON.stringify(e)
                        }), ja("✅ Pedido enviado com sucesso!", "success"), x({
                            ...p,
                            lojaCompraModal: !1,
                            lojaProdutoSelecionado: null,
                            lojaCompraTipo: null,
                            lojaCompraTamanho: null
                        }), Za()
                    } catch (e) {
                        ja("Erro ao enviar pedido", "error")
                    } else ja("Selecione a forma de pagamento", "error");
                    else ja("Selecione um tamanho", "error")
            },
            className: "flex-1 px-4 py-3 bg-gradient-to-r from-purple-600 to-pink-500 text-white rounded-xl font-semibold hover:opacity-90"
        }, "✅ Confirmar Pedido"))))))));
        if ("admin_financeiro" === l.role || "admin_master" === l.role && "financeiro" === Ee) {
            const e = "admin_master" === l.role;
            return React.createElement("div", {
                className: "min-h-screen bg-gray-50"
            }, i && React.createElement(Toast, i), n && React.createElement(LoadingOverlay, null), React.createElement(ConfigModal, {
                show: p.showConfigModal,
                onClose: () => x({...p, showConfigModal: false}),
                users: A,
                loadUsers: Ia,
                showToast: ja,
                setLoading: s,
                currentUser: l,
                state: p,
                setState: x
            }), V && React.createElement(PixQRCodeModal, {
                withdrawal: V,
                onClose: () => J(null),
                showToast: ja
            }), e ? React.createElement("nav", {
                className: "bg-gradient-to-r from-indigo-900 to-purple-900 shadow-lg"
            }, React.createElement("div", {
                className: "max-w-7xl mx-auto px-4 py-4 flex justify-between items-center"
            }, React.createElement("div", {
                className: "flex items-center gap-4"
            }, React.createElement("div", null, React.createElement("h1", {
                className: "text-xl font-bold text-white"
            }, "👑 Admin Master"), React.createElement("p", {
                className: "text-xs text-indigo-200"
            }, l.fullName)), React.createElement("div", {
                className: "flex bg-white/10 rounded-lg p-1"
            }, React.createElement("button", {
                onClick: () => he("solicitacoes"),
                className: "px-4 py-2 rounded-lg text-sm font-semibold transition-all " + ("solicitacoes" === Ee ? "bg-white text-purple-900" : "text-white hover:bg-white/10")
            }, "📋 Solicitações"), React.createElement("button", {
                onClick: () => he("financeiro"),
                className: "px-4 py-2 rounded-lg text-sm font-semibold transition-all " + ("financeiro" === Ee ? "bg-white text-green-800" : "text-white hover:bg-white/10")
            }, "💰 Financeiro"), React.createElement("button", {
                onClick: () => he("disponibilidade"),
                className: "px-4 py-2 rounded-lg text-sm font-semibold transition-all " + ("disponibilidade" === Ee ? "bg-white text-blue-800" : "text-white hover:bg-white/10")
            }, "📅 Disponibilidade"), React.createElement("button", {
                onClick: () => {
                    he("bi"), ll(), tl(), al(), dl(), pl()
                },
                className: "px-4 py-2 rounded-lg text-sm font-semibold transition-all " + ("bi" === Ee ? "bg-white text-orange-800" : "text-white hover:bg-white/10")
            }, "📊 BI"), React.createElement("button", {
                onClick: () => he("todo"),
                className: "px-4 py-2 rounded-lg text-sm font-semibold transition-all " + ("todo" === Ee ? "bg-white text-indigo-800" : "text-white hover:bg-white/10")
            }, "📋 TO-DO"), React.createElement("button", {
                onClick: () => he("operacional"),
                className: "px-4 py-2 rounded-lg text-sm font-semibold transition-all " + ("operacional" === Ee ? "bg-white text-teal-800" : "text-white hover:bg-white/10")
            }, "⚙️ Operacional"))), React.createElement("div", {
                className: "flex items-center gap-3"
            }, React.createElement("div", {
                className: "flex items-center gap-2 bg-white/10 px-3 py-1 rounded-full"
            }, React.createElement("span", {
                className: "w-2 h-2 rounded-full " + (f ? "bg-yellow-400 animate-pulse" : "bg-green-400")
            }), React.createElement("span", {
                className: "text-xs text-indigo-200"
            }, f ? "Atualizando..." : E ? `${E.toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"})}` : "⚡ 10s")), React.createElement("button", {
                onClick: ul,
                className: "px-4 py-2 bg-white/20 text-white rounded-lg hover:bg-white/30 text-sm font-semibold"
            }, "🔄"), React.createElement("button", {
                onClick: () => x({...p, showConfigModal: true}),
                className: "px-4 py-2 bg-white/20 text-white rounded-lg hover:bg-white/30 text-sm font-semibold",
                title: "Configurações"
            }, "⚙️"), React.createElement("button", {
                onClick: () => o(null),
                className: "px-4 py-2 text-white hover:bg-white/20 rounded-lg"
            }, "Sair")))) : React.createElement("nav", {
                className: "bg-green-800 shadow-lg"
            }, React.createElement("div", {
                className: "max-w-7xl mx-auto px-4 py-4 flex justify-between items-center"
            }, React.createElement("div", {
                className: "flex items-center gap-3"
            }, React.createElement("h1", {
                className: "text-xl font-bold text-white"
            }, "💰 Painel Financeiro"), React.createElement("div", {
                className: "flex items-center gap-2 bg-green-900/50 px-3 py-1 rounded-full"
            }, React.createElement("span", {
                className: "w-2 h-2 rounded-full " + (f ? "bg-yellow-400 animate-pulse" : "bg-green-400 animate-pulse")
            }), React.createElement("span", {
                className: "text-xs text-green-200"
            }, f ? "🔄 Atualizando..." : "⚡ Tempo Real (10s)")), E && React.createElement("span", {
                className: "text-xs text-green-300"
            }, "Última: ", E.toLocaleTimeString("pt-BR", {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit"
            }))), React.createElement("div", {
                className: "flex gap-2"
            }, React.createElement("button", {
                onClick: ul,
                className: "px-4 py-2 bg-green-700 text-white rounded-lg hover:bg-green-600 text-sm font-semibold"
            }, "🔄"), React.createElement("button", {
                onClick: () => o(null),
                className: "px-4 py-2 text-white hover:bg-green-700 rounded-lg"
            }, "Sair")))), p.deleteConfirm && React.createElement("div", {
                className: "fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4"
            }, React.createElement("div", {
                className: "bg-white rounded-xl shadow-2xl p-6 max-w-md w-full"
            }, React.createElement("h3", {
                className: "text-xl font-bold text-red-600 mb-4"
            }, "⚠️ Confirmar Exclusão"), React.createElement("p", {
                className: "text-gray-700 mb-2"
            }, "Tem certeza que deseja excluir esta solicitação?"), React.createElement("div", {
                className: "bg-gray-50 rounded-lg p-4 mb-4"
            }, React.createElement("p", {
                className: "text-sm"
            }, React.createElement("strong", null, "Profissional:"), " ", p.deleteConfirm.user_name), React.createElement("p", {
                className: "text-sm"
            }, React.createElement("strong", null, "Código:"), " ", p.deleteConfirm.user_cod), React.createElement("p", {
                className: "text-sm"
            }, React.createElement("strong", null, "Valor:"), " ", er(p.deleteConfirm.requested_amount)), React.createElement("p", {
                className: "text-sm"
            }, React.createElement("strong", null, "Data:"), " ", new Date(p.deleteConfirm.created_at).toLocaleString("pt-BR"))), React.createElement("p", {
                className: "text-red-600 text-sm mb-4 font-semibold"
            }, "Esta ação não pode ser desfeita!"), React.createElement("div", {
                className: "flex gap-3"
            }, React.createElement("button", {
                onClick: () => x({
                    ...p,
                    deleteConfirm: null
                }),
                className: "flex-1 px-4 py-2 bg-gray-200 text-gray-700 rounded-lg font-semibold hover:bg-gray-300"
            }, "Cancelar"), React.createElement("button", {
                onClick: () => (async e => {
                    try {
                        await fetch(`${API_URL}/withdrawals/${e}`, {
                            method: "DELETE"
                        }), ja("🗑️ Solicitação excluída!", "success"), x({
                            ...p,
                            deleteConfirm: null
                        }), Ua()
                    } catch (e) {
                        ja("Erro ao excluir", "error")
                    }
                })(p.deleteConfirm.id),
                className: "flex-1 px-4 py-2 bg-red-600 text-white rounded-lg font-semibold hover:bg-red-700"
            }, "🗑️ Excluir")))), React.createElement("div", {
                className: "bg-white border-b sticky top-0 z-10"
            }, React.createElement("div", {
                className: "max-w-7xl mx-auto px-2 flex gap-0.5 overflow-x-auto"
            }, ["solicitacoes", "validacao", "conciliacao", "resumo", "gratuidades", "restritos", "indicacoes", "promo-novatos", "loja", "relatorios", "horarios", "avisos", "backup"].map(e => React.createElement("button", {
                key: e,
                onClick: () => {
                    x({
                        ...p,
                        finTab: e
                    }), Pa(e)
                },
                className: "relative px-2 py-1.5 text-xs font-semibold whitespace-nowrap rounded-t-lg " + ((p.finTab || "solicitacoes") === e ? "text-green-700 border-b-2 border-green-600 bg-green-50" : "text-gray-600 hover:bg-gray-100")
            }, "solicitacoes" === e && React.createElement(React.Fragment, null, "📋 Solicitações", y.solicitacoes > 0 && "solicitacoes" !== (p.finTab || "solicitacoes") && React.createElement("span", {
                className: "absolute -top-1 -right-1 bg-red-500 text-white text-xs font-bold rounded-full w-5 h-5 flex items-center justify-center animate-pulse"
            }, y.solicitacoes > 9 ? "9+" : y.solicitacoes)), "validacao" === e && React.createElement(React.Fragment, null, "📊 Validação", y.validacao > 0 && "validacao" !== p.finTab && React.createElement("span", {
                className: "absolute -top-1 -right-1 bg-red-500 text-white text-xs font-bold rounded-full w-5 h-5 flex items-center justify-center animate-pulse"
            }, y.validacao > 9 ? "9+" : y.validacao)), "conciliacao" === e && "✅ Conciliação", "resumo" === e && "🔍 Resumo", "gratuidades" === e && React.createElement(React.Fragment, null, "🎁 Gratuidades", y.gratuidades > 0 && "gratuidades" !== p.finTab && React.createElement("span", {
                className: "absolute -top-1 -right-1 bg-red-500 text-white text-xs font-bold rounded-full w-5 h-5 flex items-center justify-center animate-pulse"
            }, y.gratuidades > 9 ? "9+" : y.gratuidades)), "restritos" === e && "🚫 Restritos", "indicacoes" === e && "👥 Indicações", "promo-novatos" === e && "🚀 Promo Novatos", "loja" === e && React.createElement(React.Fragment, null, "🛒 Loja", y.loja > 0 && "loja" !== p.finTab && React.createElement("span", {
                className: "absolute -top-1 -right-1 bg-red-500 text-white text-xs font-bold rounded-full w-5 h-5 flex items-center justify-center animate-pulse"
            }, y.loja > 9 ? "9+" : y.loja)), "relatorios" === e && "📈 Relatórios", "horarios" === e && "🕐 Horários", "avisos" === e && "📢 Avisos", "backup" === e && "💾 Backup")))), React.createElement("div", {
                className: "max-w-7xl mx-auto p-6"
            }, (!p.finTab || "solicitacoes" === p.finTab) && React.createElement(React.Fragment, null, (() => {
                const e = e => {
                        const t = new Date(e),
                            a = t.getDay(),
                            l = t.getHours() + t.getMinutes() / 60;
                        return 0 !== a && (6 === a ? l >= 9 && l < 12 : l >= 9 && l < 18)
                    },
                    t = new Date;
                t.setHours(0, 0, 0, 0);
                const a = q.filter(e => new Date(e.created_at) >= t),
                    l = a.filter(e => "aguardando_aprovacao" !== e.status),
                    r = (a.filter(e => "aguardando_aprovacao" === e.status), a.filter(t => ("aprovado" === t.status || "aprovado_gratuidade" === t.status) && t.updated_at && t.created_at && e(t.created_at)).map(e => (new Date(e.updated_at) - new Date(e.created_at)) / 6e4).filter(e => e > 0 && e <= 1440)),
                    o = r.length > 0 ? Math.round(r.reduce((e, t) => e + t, 0) / r.length) : 0,
                    c = a.filter(t => "aguardando_aprovacao" === t.status && e(t.created_at) && Date.now() - new Date(t.created_at).getTime() >= 36e5),
                    s = 0 === c.length ? 100 : Math.max(0, 100 - 20 * c.length),
                    n = o <= 30 ? 100 : o <= 60 ? 80 : o <= 120 ? 60 : 40,
                    m = Math.round((s + n) / 2);
                return React.createElement(React.Fragment, null, React.createElement("div", {
                    className: "grid grid-cols-2 md:grid-cols-6 gap-4 mb-6"
                }, React.createElement("div", {
                    className: "bg-white rounded-xl shadow p-4"
                }, React.createElement("p", {
                    className: "text-sm text-gray-600"
                }, "Total"), React.createElement("p", {
                    className: "text-2xl font-bold text-purple-600"
                }, q.length)), React.createElement("div", {
                    className: "bg-white rounded-xl shadow p-4"
                }, React.createElement("p", {
                    className: "text-sm text-gray-600"
                }, "Aguardando"), React.createElement("p", {
                    className: "text-2xl font-bold text-yellow-600"
                }, q.filter(e => "aguardando_aprovacao" === e.status).length)), React.createElement("div", {
                    className: "bg-white rounded-xl shadow p-4"
                }, React.createElement("p", {
                    className: "text-sm text-gray-600"
                }, "Aprovadas"), React.createElement("p", {
                    className: "text-2xl font-bold text-green-600"
                }, q.filter(e => "aprovado" === e.status).length)), React.createElement("div", {
                    className: "bg-white rounded-xl shadow p-4"
                }, React.createElement("p", {
                    className: "text-sm text-gray-600"
                }, "Aprov. Gratuidade"), React.createElement("p", {
                    className: "text-2xl font-bold text-emerald-600"
                }, q.filter(e => "aprovado_gratuidade" === e.status).length)), React.createElement("div", {
                    className: "bg-white rounded-xl shadow p-4"
                }, React.createElement("p", {
                    className: "text-sm text-gray-600"
                }, "Rejeitadas"), React.createElement("p", {
                    className: "text-2xl font-bold text-red-600"
                }, q.filter(e => "rejeitado" === e.status).length)), React.createElement("div", {
                    className: "bg-white rounded-xl shadow p-4"
                }, React.createElement("p", {
                    className: "text-sm text-gray-600"
                }, "🚨 Atrasadas (+1h)"), React.createElement("p", {
                    className: "text-2xl font-bold " + (c.length > 0 ? "text-red-600 animate-pulse" : "text-gray-400")
                }, c.length))), React.createElement("div", {
                    className: "bg-gradient-to-r from-indigo-600 to-purple-600 rounded-xl shadow-lg p-6 mb-6 text-white"
                }, React.createElement("div", {
                    className: "flex flex-col md:flex-row items-center gap-6"
                }, React.createElement("div", {
                    className: "relative w-32 h-32"
                }, React.createElement("svg", {
                    className: "w-32 h-32 transform -rotate-90"
                }, React.createElement("circle", {
                    cx: "64",
                    cy: "64",
                    r: "56",
                    stroke: "rgba(255,255,255,0.2)",
                    strokeWidth: "12",
                    fill: "none"
                }), React.createElement("circle", {
                    cx: "64",
                    cy: "64",
                    r: "56",
                    stroke: m >= 80 ? "#10b981" : m >= 50 ? "#f59e0b" : "#ef4444",
                    strokeWidth: "12",
                    fill: "none",
                    strokeDasharray: 3.52 * m + " 352",
                    strokeLinecap: "round"
                })), React.createElement("div", {
                    className: "absolute inset-0 flex flex-col items-center justify-center"
                }, React.createElement("span", {
                    className: "text-3xl font-bold"
                }, m), React.createElement("span", {
                    className: "text-xs opacity-70"
                }, "SCORE"))), React.createElement("div", {
                    className: "flex-1 grid grid-cols-2 md:grid-cols-4 gap-4"
                }, React.createElement("div", {
                    className: "bg-white/10 rounded-lg p-3 text-center"
                }, React.createElement("p", {
                    className: "text-white/70 text-xs"
                }, "Hoje"), React.createElement("p", {
                    className: "text-2xl font-bold"
                }, a.length), React.createElement("p", {
                    className: "text-xs text-white/60"
                }, l.length, " processadas")), React.createElement("div", {
                    className: "bg-white/10 rounded-lg p-3 text-center"
                }, React.createElement("p", {
                    className: "text-white/70 text-xs"
                }, "Tempo Médio"), React.createElement("p", {
                    className: "text-2xl font-bold"
                }, o < 60 ? `${o}min` : `${Math.floor(o/60)}h${o%60}m`), React.createElement("p", {
                    className: "text-xs " + (o <= 60 ? "text-green-300" : "text-red-300")
                }, o <= 30 ? "✅ Excelente" : o <= 60 ? "⚠️ Bom" : "🚨 Lento")), React.createElement("div", {
                    className: "bg-white/10 rounded-lg p-3 text-center"
                }, React.createElement("p", {
                    className: "text-white/70 text-xs"
                }, "Pendentes"), React.createElement("p", {
                    className: "text-2xl font-bold"
                }, q.filter(e => "aguardando_aprovacao" === e.status).length), React.createElement("p", {
                    className: "text-xs text-white/60"
                }, "aguardando")), React.createElement("div", {
                    className: "bg-white/10 rounded-lg p-3 text-center"
                }, React.createElement("p", {
                    className: "text-white/70 text-xs"
                }, "Prazo (1h)"), React.createElement("p", {
                    className: "text-2xl font-bold " + (0 === c.length ? "text-green-300" : "text-red-300")
                }, 0 === c.length ? "✅" : `${c.length} 🚨`), React.createElement("p", {
                    className: "text-xs text-white/60"
                }, 0 === c.length ? "Nenhum atraso" : "Ação necessária!"))))))
            })(), (() => {
                const e = q.filter(e => {
                    if ("aguardando_aprovacao" !== e.status) return !1;
                    return (Date.now() - new Date(e.created_at).getTime()) / 36e5 >= 1
                });
                return 0 === e.length ? null : React.createElement("div", {
                    className: "bg-red-50 border-2 border-red-400 rounded-xl p-4 mb-6 animate-pulse"
                }, React.createElement("div", {
                    className: "flex items-center gap-3"
                }, React.createElement("span", {
                    className: "text-3xl"
                }, "🚨"), React.createElement("div", {
                    className: "flex-1"
                }, React.createElement("p", {
                    className: "text-red-800 font-bold text-lg"
                }, "ATENÇÃO: ", e.length, " saque(s) aguardando há mais de 1 hora!"), React.createElement("p", {
                    className: "text-red-600 text-sm mt-1"
                }, "Profissionais aguardando: ", e.map(e => e.user_name || e.user_cod).join(", "))), React.createElement("button", {
                    onClick: () => x({
                        ...p,
                        filterStatus: "atrasados"
                    }),
                    className: "px-4 py-2 bg-red-600 text-white rounded-lg font-semibold hover:bg-red-700 whitespace-nowrap"
                }, "👀 Ver Atrasados")))
            })(), React.createElement("div", {
                className: "bg-white rounded-xl shadow overflow-hidden"
            }, React.createElement("div", {
                className: "p-4 border-b"
            }, React.createElement("div", {
                className: "flex flex-wrap gap-2"
            }, React.createElement("button", {
                onClick: () => x({
                    ...p,
                    filterStatus: ""
                }),
                className: "px-4 py-2 rounded-lg font-semibold text-sm " + (p.filterStatus ? "bg-gray-100 hover:bg-gray-200" : "bg-purple-600 text-white")
            }, "📋 Todas (", q.length, ")"), React.createElement("button", {
                onClick: () => x({
                    ...p,
                    filterStatus: "atrasados"
                }),
                className: "px-4 py-2 rounded-lg font-semibold text-sm " + ("atrasados" === p.filterStatus ? "bg-red-600 text-white" : "bg-gray-100 hover:bg-gray-200")
            }, "🚨 Atrasados (", q.filter(e => "aguardando_aprovacao" === e.status && Date.now() - new Date(e.created_at).getTime() >= 36e5).length, ")"), React.createElement("button", {
                onClick: () => x({
                    ...p,
                    filterStatus: "aguardando_aprovacao"
                }),
                className: "px-4 py-2 rounded-lg font-semibold text-sm " + ("aguardando_aprovacao" === p.filterStatus ? "bg-yellow-500 text-white" : "bg-gray-100 hover:bg-gray-200")
            }, "⏳ Aguardando (", q.filter(e => "aguardando_aprovacao" === e.status).length, ")"), React.createElement("button", {
                onClick: () => x({
                    ...p,
                    filterStatus: "aprovado"
                }),
                className: "px-4 py-2 rounded-lg font-semibold text-sm " + ("aprovado" === p.filterStatus ? "bg-green-600 text-white" : "bg-gray-100 hover:bg-gray-200")
            }, "✅ Aprovadas (", q.filter(e => "aprovado" === e.status).length, ")"), React.createElement("button", {
                onClick: () => x({
                    ...p,
                    filterStatus: "aprovado_gratuidade"
                }),
                className: "px-4 py-2 rounded-lg font-semibold text-sm " + ("aprovado_gratuidade" === p.filterStatus ? "bg-emerald-600 text-white" : "bg-gray-100 hover:bg-gray-200")
            }, "🎁 Aprov. Gratuidade (", q.filter(e => "aprovado_gratuidade" === e.status).length, ")"), React.createElement("button", {
                onClick: () => x({
                    ...p,
                    filterStatus: "rejeitado"
                }),
                className: "px-4 py-2 rounded-lg font-semibold text-sm " + ("rejeitado" === p.filterStatus ? "bg-red-600 text-white" : "bg-gray-100 hover:bg-gray-200")
            }, "❌ Rejeitadas (", q.filter(e => "rejeitado" === e.status).length, ")"), React.createElement("button", {
                onClick: () => x({
                    ...p,
                    filterStatus: "inativo"
                }),
                className: "px-4 py-2 rounded-lg font-semibold text-sm " + ("inativo" === p.filterStatus ? "bg-orange-500 text-white" : "bg-gray-100 hover:bg-gray-200")
            }, "⚠️ Inativo (", q.filter(e => "inativo" === e.status).length, ")"))), z.length > 0 && React.createElement("div", {
                className: "bg-gradient-to-r from-purple-600 to-indigo-600 rounded-xl p-4 mb-4 shadow-lg"
            }, React.createElement("div", {
                className: "flex items-center justify-between flex-wrap gap-4"
            }, React.createElement("div", {
                className: "flex items-center gap-4"
            }, React.createElement("div", {
                className: "bg-white/20 rounded-lg px-4 py-2"
            }, React.createElement("p", {
                className: "text-white/70 text-xs"
            }, "Selecionadas"), React.createElement("p", {
                className: "text-white text-2xl font-bold"
            }, z.length)), React.createElement("div", {
                className: "bg-white/20 rounded-lg px-4 py-2"
            }, React.createElement("p", {
                className: "text-white/70 text-xs"
            }, "Total Solicitado"), React.createElement("p", {
                className: "text-white text-2xl font-bold"
            }, er(q.filter(e => z.includes(e.id)).reduce((e, t) => e + parseFloat(t.requested_amount || 0), 0)))), React.createElement("div", {
                className: "bg-white/20 rounded-lg px-4 py-2"
            }, React.createElement("p", {
                className: "text-white/70 text-xs"
            }, "Total Profissional"), React.createElement("p", {
                className: "text-white text-2xl font-bold"
            }, er(q.filter(e => z.includes(e.id)).reduce((e, t) => e + parseFloat(t.final_amount || 0), 0))))), React.createElement("button", {
                onClick: () => B([]),
                className: "bg-white/20 hover:bg-white/30 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
            }, "✕ Limpar seleção"))), React.createElement("div", {
                className: "overflow-x-auto"
            }, React.createElement("table", {
                className: "w-full text-sm table-fixed"
            }, React.createElement("thead", {
                className: "bg-gray-50"
            }, React.createElement("tr", null, React.createElement("th", {
                className: "px-2 py-3 text-center w-[40px]"
            }, React.createElement("input", {
                type: "checkbox",
                checked: q.filter(e => !p.filterStatus || ("atrasados" === p.filterStatus ? "aguardando_aprovacao" === e.status && Date.now() - new Date(e.created_at).getTime() >= 36e5 : e.status === p.filterStatus)).length > 0 && q.filter(e => !p.filterStatus || ("atrasados" === p.filterStatus ? "aguardando_aprovacao" === e.status && Date.now() - new Date(e.created_at).getTime() >= 36e5 : e.status === p.filterStatus)).every(e => z.includes(e.id)),
                onChange: e => {
                    const t = q.filter(e => !p.filterStatus || ("atrasados" === p.filterStatus ? "aguardando_aprovacao" === e.status && Date.now() - new Date(e.created_at).getTime() >= 36e5 : e.status === p.filterStatus));
                    e.target.checked ? B([...new Set([...z, ...t.map(e => e.id)])]) : B(z.filter(e => !t.map(e => e.id).includes(e)))
                },
                className: "w-4 h-4",
                title: "Selecionar todos"
            })), React.createElement("th", {
                className: "px-2 py-3 text-left w-[90px]"
            }, "Data"), React.createElement("th", {
                className: "px-2 py-3 text-left w-[140px]"
            }, "Nome"), React.createElement("th", {
                className: "px-2 py-3 text-left w-[110px]"
            }, "CPF"), React.createElement("th", {
                className: "px-2 py-3 text-left w-[70px]"
            }, "Código"), React.createElement("th", {
                className: "px-2 py-3 text-right w-[90px]"
            }, "Solicitado"), React.createElement("th", {
                className: "px-2 py-3 text-center w-[70px]"
            }, "Débito"), React.createElement("th", {
                className: "px-2 py-3 text-right w-[90px]"
            }, "Valor Prof."), React.createElement("th", {
                className: "px-2 py-3 text-left w-[120px]"
            }, "PIX"), React.createElement("th", {
                className: "px-2 py-3 text-center w-[130px]"
            }, "Saldo"), React.createElement("th", {
                className: "px-2 py-3 text-center w-[160px]"
            }, "Status"), React.createElement("th", {
                className: "px-2 py-3 text-center w-[50px]"
            }, "Ações"))), React.createElement("tbody", null, q.filter(e => !p.filterStatus || ("atrasados" === p.filterStatus ? "aguardando_aprovacao" === e.status && Date.now() - new Date(e.created_at).getTime() >= 36e5 : e.status === p.filterStatus)).map(e => {
                const t = "aguardando_aprovacao" === e.status && Date.now() - new Date(e.created_at).getTime() >= 36e5,
                    a = Math.floor((Date.now() - new Date(e.created_at).getTime()) / 6e4),
                    l = Math.floor(a / 60),
                    r = a % 60,
                    o = "aprovado" === e.status,
                    c = "aprovado_gratuidade" === e.status,
                    s = "rejeitado" === e.status,
                    n = s ? "font-bold text-red-800 bg-red-100" : c ? "font-bold bg-emerald-100 border-l-4 border-l-emerald-500" : o ? "font-bold bg-green-100" : "",
                    m = new Date(e.created_at),
                    i = m.toLocaleDateString("pt-BR"),
                    d = m.toLocaleTimeString("pt-BR", {
                        hour: "2-digit",
                        minute: "2-digit"
                    });
                return React.createElement("tr", {
                    key: e.id,
                    className: `border-t hover:bg-gray-50 ${z.includes(e.id)?"bg-purple-50":""} ${!t||s||o||c?"":"bg-red-50 border-l-4 border-l-red-500"} ${n} ${!e.has_gratuity||o||s||c?"":"row-green"} ${e.is_restricted&&!s?"row-red":""}`
                }, React.createElement("td", {
                    className: "px-2 py-3 text-center"
                }, React.createElement("input", {
                    type: "checkbox",
                    checked: z.includes(e.id),
                    onChange: t => {
                        t.target.checked ? B([...z, e.id]) : B(z.filter(t => t !== e.id))
                    },
                    className: "w-4 h-4"
                })), React.createElement("td", {
                    className: "px-2 py-3 text-xs " + (s ? "text-red-800" : c ? "text-emerald-800" : o ? "text-green-800" : "")
                }, React.createElement("div", {
                    className: "flex flex-col"
                }, React.createElement("span", {
                    className: "font-medium"
                }, i), React.createElement("span", {
                    className: "text-[10px] text-gray-500"
                }, d)), "aguardando_aprovacao" === e.status && React.createElement("div", {
                    className: "mt-1 px-2 py-0.5 rounded text-xs font-bold inline-flex items-center gap-1 " + (t ? "bg-red-500 text-white animate-pulse" : a >= 90 ? "bg-orange-100 text-orange-700" : "bg-gray-100 text-gray-600")
                }, t ? "🚨" : a >= 90 ? "⚠️" : "⏱️", l > 0 ? `${l}h ${r}m` : `${r}min`, t && React.createElement("span", {
                    className: "text-[10px] ml-1"
                }, "ATRASADO"))), React.createElement("td", {
                    className: "px-2 py-3 text-xs truncate " + (s ? "text-red-800" : c ? "text-emerald-800" : o ? "text-green-800" : "")
                }, e.user_name), React.createElement("td", {
                    className: "px-2 py-3 text-xs " + (s ? "text-red-800" : c ? "text-emerald-800" : o ? "text-green-800" : "")
                }, e.cpf), React.createElement("td", {
                    className: "px-2 py-3 font-mono text-xs " + (s ? "text-red-800" : c ? "text-emerald-800" : o ? "text-green-800" : "")
                }, e.user_cod), React.createElement("td", {
                    className: "px-2 py-3 text-right font-semibold text-xs " + (s ? "text-red-800" : c ? "text-emerald-800" : o ? "text-green-800" : "")
                }, er(e.requested_amount)), React.createElement("td", {
                    className: "px-2 py-3 text-center"
                }, React.createElement("div", {
                    className: "flex flex-col items-center"
                }, React.createElement("input", {
                    type: "checkbox",
                    checked: e.debito || !1,
                    onChange: t => (async (e, t) => {
                        try {
                            await fetch(`${API_URL}/withdrawals/${e}/debito`, {
                                method: "PATCH",
                                headers: {
                                    "Content-Type": "application/json"
                                },
                                body: JSON.stringify({
                                    debito: t,
                                    debitoAt: t ? (new Date).toISOString() : null
                                })
                            }), Ua(), ja(t ? "✅ Débito registrado!" : "❌ Débito removido", "success")
                        } catch (e) {
                            ja("Erro", "error")
                        }
                    })(e.id, t.target.checked),
                    className: "w-4 h-4"
                }), e.debito && e.debito_at && React.createElement("span", {
                    className: "text-[10px] mt-1 " + (s ? "text-red-800" : c ? "text-emerald-800" : o ? "text-green-800" : "text-gray-500")
                }, new Date(e.debito_at).toLocaleDateString("pt-BR")))), React.createElement("td", {
                    className: "px-2 py-3 text-right text-xs " + (s ? "text-red-800" : c ? "text-emerald-800" : o ? "text-green-800" : "")
                }, er(e.final_amount)), React.createElement("td", {
                    className: "px-2 py-3 " + (s ? "text-red-800" : c ? "text-emerald-800" : o ? "text-green-800" : "")
                }, React.createElement("div", {
                    className: "flex items-center gap-1"
                }, React.createElement("span", {
                    className: "text-[10px] truncate flex-1",
                    title: e.pix_key
                }, e.pix_key), React.createElement("button", {
                    onClick: () => J(e),
                    className: "text-lg hover:scale-125 transition-transform",
                    title: "Gerar QR Code PIX"
                }, "💠")), e.has_gratuity && React.createElement("p", {
                    className: "text-[10px] font-bold text-emerald-700 mt-0.5"
                }, "🎁 GRATUIDADE")), React.createElement("td", {
                    className: "px-2 py-3 text-center"
                }, "validado" === e.saldo_status ? React.createElement("div", {
                    className: "flex flex-col items-center gap-1"
                }, React.createElement("span", {
                    className: "text-[10px] font-bold text-green-700 bg-green-100 px-2 py-1 rounded"
                }, "SALDO VALIDADO"), React.createElement("button", {
                    onClick: () => Ql(e.id, null),
                    className: "text-[9px] text-gray-400 hover:text-gray-600"
                }, "↩ desfazer")) : "insuficiente" === e.saldo_status ? React.createElement("div", {
                    className: "flex flex-col items-center gap-1"
                }, React.createElement("span", {
                    className: "text-[10px] font-bold text-red-700 bg-red-100 px-2 py-1 rounded"
                }, "SALDO INSUFICIENTE"), React.createElement("button", {
                    onClick: () => Ql(e.id, null),
                    className: "text-[9px] text-gray-400 hover:text-gray-600"
                }, "↩ desfazer")) : React.createElement("div", {
                    className: "flex gap-1 justify-center"
                }, React.createElement("button", {
                    onClick: () => Ql(e.id, "validado"),
                    className: "text-lg hover:scale-125 transition-transform",
                    title: "Saldo Validado"
                }, "✅"), React.createElement("button", {
                    onClick: () => Ql(e.id, "insuficiente"),
                    className: "text-lg hover:scale-125 transition-transform",
                    title: "Saldo Insuficiente"
                }, "❌"))), React.createElement("td", {
                    className: "px-2 py-3"
                }, React.createElement("select", {
                    value: p[`showReject_${e.id}`] ? "rejeitado" : e.status,
                    onChange: t => {
                        return a = e.id, void("rejeitado" === (l = t.target.value) ? x({
                            ...p,
                            [`showReject_${a}`]: !0,
                            [`pendingStatus_${a}`]: l
                        }) : Jl(a, l));
                        var a, l
                    },
                    className: "px-1 py-1 border rounded text-xs w-full"
                }, React.createElement("option", {
                    value: "aguardando_aprovacao"
                }, "⏳ Aguardando"), React.createElement("option", {
                    value: "aprovado"
                }, "✅ Aprovado"), React.createElement("option", {
                    value: "aprovado_gratuidade"
                }, "✅ c/ Gratuidade"), React.createElement("option", {
                    value: "rejeitado"
                }, "❌ Rejeitado"), React.createElement("option", {
                    value: "inativo"
                }, "⚠️ Inativo")), p[`showReject_${e.id}`] && React.createElement("div", {
                    className: "mt-2 space-y-2"
                }, React.createElement("input", {
                    type: "text",
                    placeholder: "Motivo da rejeição...",
                    value: p[`reject_${e.id}`] || "",
                    onChange: t => x({
                        ...p,
                        [`reject_${e.id}`]: t.target.value
                    }),
                    className: "w-full px-2 py-1 border rounded text-xs"
                }), React.createElement("div", {
                    className: "flex gap-1"
                }, React.createElement("button", {
                    onClick: () => {
                        p[`reject_${e.id}`] ? Jl(e.id, "rejeitado", p[`reject_${e.id}`]) : ja("Informe o motivo", "error")
                    },
                    className: "flex-1 px-2 py-1 bg-red-600 text-white rounded text-xs"
                }, "Confirmar"), React.createElement("button", {
                    onClick: () => x({
                        ...p,
                        [`showReject_${e.id}`]: !1
                    }),
                    className: "px-2 py-1 bg-gray-400 text-white rounded text-xs"
                }, "✕"))), e.reject_reason && "rejeitado" === e.status && React.createElement("p", {
                    className: "text-[10px] text-red-600 mt-1 truncate"
                }, "Motivo: ", e.reject_reason), e.admin_name && "aguardando_aprovacao" !== e.status && React.createElement("p", {
                    className: "text-[10px] text-purple-600 mt-1 font-medium"
                }, "👤 ", e.admin_name)), React.createElement("td", {
                    className: "px-2 py-3 text-center"
                }, React.createElement("button", {
                    onClick: () => x({
                        ...p,
                        deleteConfirm: e
                    }),
                    className: "px-2 py-1 bg-red-600 text-white rounded text-xs hover:bg-red-700",
                    title: "Excluir"
                }, "🗑️")))
            })))))), "validacao" === p.finTab && React.createElement(React.Fragment, null, React.createElement("div", {
                className: "bg-white rounded-xl shadow p-4 mb-6"
            }, React.createElement("div", {
                className: "flex flex-wrap gap-4 items-end"
            }, React.createElement("div", null, React.createElement("label", {
                className: "block text-sm font-semibold mb-1"
            }, "Filtrar por"), React.createElement("select", {
                value: p.validacaoTipo || "solicitacao",
                onChange: e => x({
                    ...p,
                    validacaoTipo: e.target.value
                }),
                className: "px-4 py-2 border rounded-lg"
            }, React.createElement("option", {
                value: "solicitacao"
            }, "📅 Data da Solicitação"), React.createElement("option", {
                value: "debito"
            }, "💳 Data do Débito"))), React.createElement("div", null, React.createElement("label", {
                className: "block text-sm font-semibold mb-1"
            }, "Data Início"), React.createElement("input", {
                type: "date",
                value: p.validacaoDataInicio || "",
                onChange: e => x({
                    ...p,
                    validacaoDataInicio: e.target.value
                }),
                className: "px-4 py-2 border rounded-lg"
            })), React.createElement("div", null, React.createElement("label", {
                className: "block text-sm font-semibold mb-1"
            }, "Data Fim"), React.createElement("input", {
                type: "date",
                value: p.validacaoDataFim || "",
                onChange: e => x({
                    ...p,
                    validacaoDataFim: e.target.value
                }),
                className: "px-4 py-2 border rounded-lg"
            })), React.createElement("button", {
                onClick: () => {
                    const e = (new Date).toISOString().split("T")[0];
                    x({
                        ...p,
                        validacaoDataInicio: e,
                        validacaoDataFim: e
                    })
                },
                className: "px-6 py-2 bg-green-600 text-white rounded-lg font-semibold hover:bg-green-700"
            }, "📆 Hoje"), React.createElement("button", {
                onClick: () => x({
                    ...p,
                    validacaoDataInicio: "",
                    validacaoDataFim: ""
                }),
                className: "px-6 py-2 bg-gray-200 text-gray-700 rounded-lg font-semibold hover:bg-gray-300"
            }, "🔄 Limpar"))), (() => {
                const e = p.validacaoTipo || "solicitacao",
                    t = p.validacaoDataInicio,
                    a = p.validacaoDataFim,
                    l = q.filter(l => {
                        if (!t && !a) return !0;
                        let r;
                        if ("solicitacao" === e) r = new Date(l.created_at).toISOString().split("T")[0];
                        else {
                            if (!l.debito_at) return !1;
                            r = new Date(l.debito_at).toISOString().split("T")[0]
                        }
                        return t && a ? r >= t && r <= a : t ? r >= t : !a || r <= a
                    }),
                    r = l.length,
                    o = l.filter(e => "rejeitado" === e.status).length,
                    c = l.filter(e => "aprovado" === e.status || "aprovado_gratuidade" === e.status).length,
                    s = l.filter(e => "aprovado" === e.status).length,
                    n = l.filter(e => "aprovado_gratuidade" === e.status).length,
                    m = l.filter(e => "aprovado" === e.status).reduce((e, t) => e + parseFloat(t.requested_amount || 0), 0),
                    i = .045 * m,
                    d = l.filter(e => "aprovado_gratuidade" === e.status).reduce((e, t) => e + parseFloat(t.requested_amount || 0), 0),
                    x = .045 * d,
                    u = m + d;
                return React.createElement(React.Fragment, null, React.createElement("div", {
                    className: "bg-blue-50 border border-blue-200 rounded-xl p-4 mb-6"
                }, React.createElement("p", {
                    className: "text-blue-800 font-semibold"
                }, "solicitacao" === e ? "📅 Filtrando por Data da Solicitação" : "💳 Filtrando por Data do Débito", t && a && t === a && ` - ${new Date(t+"T12:00:00").toLocaleDateString("pt-BR")}`, t && a && t !== a && ` - ${new Date(t+"T12:00:00").toLocaleDateString("pt-BR")} até ${new Date(a+"T12:00:00").toLocaleDateString("pt-BR")}`, !t && !a && " - Todos os períodos")), React.createElement("div", {
                    className: "grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 mb-4"
                }, React.createElement("div", {
                    className: "bg-white rounded-xl shadow p-4 border-l-4 border-gray-500"
                }, React.createElement("p", {
                    className: "text-sm text-gray-600"
                }, "📥 Total Recebidas"), React.createElement("p", {
                    className: "text-3xl font-bold text-gray-700"
                }, r)), React.createElement("div", {
                    className: "bg-white rounded-xl shadow p-4 border-l-4 border-green-500"
                }, React.createElement("p", {
                    className: "text-sm text-gray-600"
                }, "✅ Total Aprovadas"), React.createElement("p", {
                    className: "text-3xl font-bold text-green-600"
                }, c)), React.createElement("div", {
                    className: "bg-white rounded-xl shadow p-4 border-l-4 border-blue-500"
                }, React.createElement("p", {
                    className: "text-sm text-gray-600"
                }, "✅ Sem Gratuidade"), React.createElement("p", {
                    className: "text-3xl font-bold text-blue-600"
                }, s)), React.createElement("div", {
                    className: "bg-white rounded-xl shadow p-4 border-l-4 border-purple-500"
                }, React.createElement("p", {
                    className: "text-sm text-gray-600"
                }, "🎁 Com Gratuidade"), React.createElement("p", {
                    className: "text-3xl font-bold text-purple-600"
                }, n)), React.createElement("div", {
                    className: "bg-white rounded-xl shadow p-4 border-l-4 border-red-500"
                }, React.createElement("p", {
                    className: "text-sm text-gray-600"
                }, "❌ Rejeitadas"), React.createElement("p", {
                    className: "text-3xl font-bold text-red-600"
                }, o))), React.createElement("div", {
                    className: "grid grid-cols-1 md:grid-cols-3 gap-4"
                }, React.createElement("div", {
                    className: "bg-gradient-to-r from-blue-500 to-indigo-600 rounded-xl shadow p-6 text-white"
                }, React.createElement("p", {
                    className: "text-sm opacity-90"
                }, "💵 Valor Total Aprovado"), React.createElement("p", {
                    className: "text-4xl font-bold mt-2"
                }, er(u)), React.createElement("p", {
                    className: "text-xs opacity-75 mt-2"
                }, "Soma de ", c, " aprovações (com + sem gratuidade)")), React.createElement("div", {
                    className: "bg-gradient-to-r from-green-500 to-emerald-600 rounded-xl shadow p-6 text-white"
                }, React.createElement("p", {
                    className: "text-sm opacity-90"
                }, "💰 Lucro com Saque (4,5%)"), React.createElement("p", {
                    className: "text-4xl font-bold mt-2"
                }, er(i)), React.createElement("p", {
                    className: "text-xs opacity-75 mt-2"
                }, "Baseado em ", s, " aprovações sem gratuidade (", er(m), ")")), React.createElement("div", {
                    className: "bg-gradient-to-r from-red-500 to-orange-500 rounded-xl shadow p-6 text-white"
                }, React.createElement("p", {
                    className: "text-sm opacity-90"
                }, "📉 Deixou de Arrecadar"), React.createElement("p", {
                    className: "text-4xl font-bold mt-2"
                }, er(x)), React.createElement("p", {
                    className: "text-xs opacity-75 mt-2"
                }, "Baseado em ", n, " aprovações com gratuidade (", er(d), ")"))))
            })()), "conciliacao" === p.finTab && React.createElement(React.Fragment, null, React.createElement("div", {
                className: "grid md:grid-cols-5 gap-4 mb-6"
            }, React.createElement("div", {
                className: "bg-white rounded-xl shadow p-4"
            }, React.createElement("p", {
                className: "text-sm text-gray-600"
            }, "Aprovados"), React.createElement("p", {
                className: "text-2xl font-bold text-green-600"
            }, K.total_aprovados || 0)), React.createElement("div", {
                className: "bg-white rounded-xl shadow p-4"
            }, React.createElement("p", {
                className: "text-sm text-gray-600"
            }, "Conciliados"), React.createElement("p", {
                className: "text-2xl font-bold text-blue-600"
            }, K.total_conciliado || 0)), React.createElement("div", {
                className: "bg-white rounded-xl shadow p-4"
            }, React.createElement("p", {
                className: "text-sm text-gray-600"
            }, "Pend. Conc."), React.createElement("p", {
                className: "text-2xl font-bold text-yellow-600"
            }, K.pendente_conciliacao || 0))), React.createElement("div", {
                className: "bg-white rounded-xl shadow overflow-hidden"
            }, React.createElement("table", {
                className: "w-full text-sm"
            }, React.createElement("thead", {
                className: "bg-gray-50"
            }, React.createElement("tr", null, React.createElement("th", {
                className: "px-4 py-3 text-left"
            }, "Datas"), React.createElement("th", {
                className: "px-4 py-3 text-left"
            }, "Nome"), React.createElement("th", {
                className: "px-4 py-3 text-left"
            }, "CPF"), React.createElement("th", {
                className: "px-4 py-3 text-left"
            }, "Código"), React.createElement("th", {
                className: "px-4 py-3 text-right"
            }, "Solicitado"), React.createElement("th", {
                className: "px-4 py-3 text-right"
            }, "Valor Profissional"), React.createElement("th", {
                className: "px-4 py-3 text-center"
            }, "Gratuidade"), React.createElement("th", {
                className: "px-4 py-3 text-center"
            }, "OMIE"))), React.createElement("tbody", null, q.filter(e => e.status?.includes("aprovado")).map(e => {
                const t = new Date(e.created_at),
                    a = t.toLocaleDateString("pt-BR"),
                    l = t.toLocaleTimeString("pt-BR", {
                        hour: "2-digit",
                        minute: "2-digit"
                    }),
                    r = e.approved_at ? new Date(e.approved_at) : null,
                    o = r ? r.toLocaleDateString("pt-BR") : "-",
                    c = r ? r.toLocaleTimeString("pt-BR", {
                        hour: "2-digit",
                        minute: "2-digit"
                    }) : "",
                    s = e.has_gratuity;
                return React.createElement("tr", {
                    key: e.id,
                    className: "border-t hover:bg-gray-50 " + (s ? "bg-emerald-50 border-l-4 border-l-emerald-500" : "")
                }, React.createElement("td", {
                    className: "px-4 py-3"
                }, React.createElement("div", {
                    className: "flex flex-col text-[10px]"
                }, React.createElement("span", {
                    className: "text-gray-600"
                }, "Solicitado: ", React.createElement("span", {
                    className: "font-medium text-gray-800"
                }, a), " às ", React.createElement("span", {
                    className: "font-medium text-gray-800"
                }, l)), React.createElement("span", {
                    className: "text-green-600"
                }, "Realizado: ", React.createElement("span", {
                    className: "font-medium text-green-700"
                }, o), c && React.createElement(React.Fragment, null, " às ", React.createElement("span", {
                    className: "font-medium text-green-700"
                }, c))))), React.createElement("td", {
                    className: "px-4 py-3"
                }, e.user_name), React.createElement("td", {
                    className: "px-4 py-3"
                }, e.cpf), React.createElement("td", {
                    className: "px-4 py-3 font-mono"
                }, e.user_cod), React.createElement("td", {
                    className: "px-4 py-3 text-right"
                }, er(e.requested_amount)), React.createElement("td", {
                    className: "px-4 py-3 text-right font-semibold"
                }, er(e.final_amount)), React.createElement("td", {
                    className: "px-4 py-3 text-center"
                }, s ? React.createElement("span", {
                    className: "text-xs font-bold text-emerald-700 bg-emerald-100 px-2 py-1 rounded"
                }, "SIM") : React.createElement("span", {
                    className: "text-xs text-gray-400"
                }, "-")), React.createElement("td", {
                    className: "px-4 py-3 text-center"
                }, React.createElement("input", {
                    type: "checkbox",
                    checked: e.conciliacao_omie,
                    onChange: t => (async (e, t, a) => {
                        try {
                            await fetch(`${API_URL}/withdrawals/${e}/conciliacao`, {
                                method: "PATCH",
                                headers: {
                                    "Content-Type": "application/json"
                                },
                                body: JSON.stringify({
                                    [t]: a
                                })
                            }), Ua(), Va()
                        } catch (e) {
                            ja("Erro", "error")
                        }
                    })(e.id, "conciliacaoOmie", t.target.checked),
                    className: "w-5 h-5"
                })))
            }))))), "resumo" === p.finTab && React.createElement(React.Fragment, null, React.createElement("div", {
                className: "bg-white rounded-xl shadow p-4 mb-6"
            }, React.createElement("div", {
                className: "flex gap-4"
            }, React.createElement("input", {
                type: "text",
                placeholder: "🔍 Buscar por código do profissional...",
                value: p.searchCod || "",
                onChange: e => x({
                    ...p,
                    searchCod: e.target.value
                }),
                className: "flex-1 px-4 py-2 border rounded-lg"
            }), p.searchCod && React.createElement("button", {
                onClick: () => x({
                    ...p,
                    searchCod: ""
                }),
                className: "px-4 py-2 bg-gray-200 text-gray-700 rounded-lg font-semibold"
            }, "✕ Limpar"))), p.searchCod && (() => {
                const e = q.filter(e => e.user_cod.toLowerCase().includes(p.searchCod.toLowerCase()));
                return React.createElement(React.Fragment, null, React.createElement("div", {
                    className: "grid grid-cols-2 md:grid-cols-5 gap-4 mb-6"
                }, React.createElement("div", {
                    className: "bg-white rounded-xl shadow p-4"
                }, React.createElement("p", {
                    className: "text-sm text-gray-600"
                }, "Total"), React.createElement("p", {
                    className: "text-2xl font-bold text-purple-600"
                }, e.length)), React.createElement("div", {
                    className: "bg-white rounded-xl shadow p-4"
                }, React.createElement("p", {
                    className: "text-sm text-gray-600"
                }, "Aguardando"), React.createElement("p", {
                    className: "text-2xl font-bold text-yellow-600"
                }, e.filter(e => "aguardando_aprovacao" === e.status).length)), React.createElement("div", {
                    className: "bg-white rounded-xl shadow p-4"
                }, React.createElement("p", {
                    className: "text-sm text-gray-600"
                }, "Aprovadas"), React.createElement("p", {
                    className: "text-2xl font-bold text-green-600"
                }, e.filter(e => "aprovado" === e.status).length)), React.createElement("div", {
                    className: "bg-white rounded-xl shadow p-4"
                }, React.createElement("p", {
                    className: "text-sm text-gray-600"
                }, "Aprov. Gratuidade"), React.createElement("p", {
                    className: "text-2xl font-bold text-emerald-600"
                }, e.filter(e => "aprovado_gratuidade" === e.status).length)), React.createElement("div", {
                    className: "bg-white rounded-xl shadow p-4"
                }, React.createElement("p", {
                    className: "text-sm text-gray-600"
                }, "Rejeitadas"), React.createElement("p", {
                    className: "text-2xl font-bold text-red-600"
                }, e.filter(e => "rejeitado" === e.status).length))), React.createElement("div", {
                    className: "bg-white rounded-xl shadow overflow-hidden"
                }, React.createElement("div", {
                    className: "p-4 border-b"
                }, React.createElement("div", {
                    className: "flex flex-wrap gap-2"
                }, React.createElement("button", {
                    onClick: () => x({
                        ...p,
                        resumoFilter: ""
                    }),
                    className: "px-4 py-2 rounded-lg font-semibold text-sm " + (p.resumoFilter ? "bg-gray-100 hover:bg-gray-200" : "bg-purple-600 text-white")
                }, "📋 Todas (", e.length, ")"), React.createElement("button", {
                    onClick: () => x({
                        ...p,
                        resumoFilter: "aguardando_aprovacao"
                    }),
                    className: "px-4 py-2 rounded-lg font-semibold text-sm " + ("aguardando_aprovacao" === p.resumoFilter ? "bg-yellow-500 text-white" : "bg-gray-100 hover:bg-gray-200")
                }, "⏳ Aguardando (", e.filter(e => "aguardando_aprovacao" === e.status).length, ")"), React.createElement("button", {
                    onClick: () => x({
                        ...p,
                        resumoFilter: "aprovado"
                    }),
                    className: "px-4 py-2 rounded-lg font-semibold text-sm " + ("aprovado" === p.resumoFilter ? "bg-green-600 text-white" : "bg-gray-100 hover:bg-gray-200")
                }, "✅ Aprovadas (", e.filter(e => "aprovado" === e.status).length, ")"), React.createElement("button", {
                    onClick: () => x({
                        ...p,
                        resumoFilter: "aprovado_gratuidade"
                    }),
                    className: "px-4 py-2 rounded-lg font-semibold text-sm " + ("aprovado_gratuidade" === p.resumoFilter ? "bg-emerald-600 text-white" : "bg-gray-100 hover:bg-gray-200")
                }, "🎁 Aprov. Gratuidade (", e.filter(e => "aprovado_gratuidade" === e.status).length, ")"), React.createElement("button", {
                    onClick: () => x({
                        ...p,
                        resumoFilter: "rejeitado"
                    }),
                    className: "px-4 py-2 rounded-lg font-semibold text-sm " + ("rejeitado" === p.resumoFilter ? "bg-red-600 text-white" : "bg-gray-100 hover:bg-gray-200")
                }, "❌ Rejeitadas (", e.filter(e => "rejeitado" === e.status).length, ")"), React.createElement("button", {
                    onClick: () => x({
                        ...p,
                        resumoFilter: "inativo"
                    }),
                    className: "px-4 py-2 rounded-lg font-semibold text-sm " + ("inativo" === p.resumoFilter ? "bg-orange-500 text-white" : "bg-gray-100 hover:bg-gray-200")
                }, "⚠️ Inativo (", e.filter(e => "inativo" === e.status).length, ")"))), React.createElement("div", {
                    className: "overflow-x-auto"
                }, React.createElement("table", {
                    className: "w-full text-sm"
                }, React.createElement("thead", {
                    className: "bg-gray-50"
                }, React.createElement("tr", null, React.createElement("th", {
                    className: "px-4 py-3 text-left"
                }, "Datas"), React.createElement("th", {
                    className: "px-4 py-3 text-left"
                }, "Nome"), React.createElement("th", {
                    className: "px-4 py-3 text-left"
                }, "CPF"), React.createElement("th", {
                    className: "px-4 py-3 text-left"
                }, "Código"), React.createElement("th", {
                    className: "px-4 py-3 text-right"
                }, "Solicitado"), React.createElement("th", {
                    className: "px-4 py-3 text-right"
                }, "Valor Profissional"), React.createElement("th", {
                    className: "px-4 py-3 text-left"
                }, "PIX"), React.createElement("th", {
                    className: "px-4 py-3 text-center"
                }, "Gratuidade"), React.createElement("th", {
                    className: "px-4 py-3 text-center"
                }, "Status"))), React.createElement("tbody", null, e.filter(e => !p.resumoFilter || e.status === p.resumoFilter).map(e => {
                    const t = new Date(e.created_at),
                        a = t.toLocaleDateString("pt-BR"),
                        l = t.toLocaleTimeString("pt-BR", {
                            hour: "2-digit",
                            minute: "2-digit"
                        }),
                        r = e.approved_at ? new Date(e.approved_at) : null,
                        o = r ? r.toLocaleDateString("pt-BR") : "-",
                        c = r ? r.toLocaleTimeString("pt-BR", {
                            hour: "2-digit",
                            minute: "2-digit"
                        }) : "",
                        s = "aprovado" === e.status || "aprovado_gratuidade" === e.status;
                    return React.createElement("tr", {
                        key: e.id,
                        className: `border-t hover:bg-gray-50 ${e.has_gratuity?"bg-emerald-50 border-l-4 border-l-emerald-500":""} ${e.is_restricted?"row-red":""}`
                    }, React.createElement("td", {
                        className: "px-4 py-3"
                    }, React.createElement("div", {
                        className: "flex flex-col text-[10px]"
                    }, React.createElement("span", {
                        className: "text-gray-600"
                    }, "Solicitado: ", React.createElement("span", {
                        className: "font-medium text-gray-800"
                    }, a), " às ", React.createElement("span", {
                        className: "font-medium text-gray-800"
                    }, l)), s && React.createElement("span", {
                        className: "text-green-600"
                    }, "Realizado: ", React.createElement("span", {
                        className: "font-medium text-green-700"
                    }, o), c && React.createElement(React.Fragment, null, " às ", React.createElement("span", {
                        className: "font-medium text-green-700"
                    }, c))))), React.createElement("td", {
                        className: "px-4 py-3"
                    }, e.user_name), React.createElement("td", {
                        className: "px-4 py-3"
                    }, e.cpf), React.createElement("td", {
                        className: "px-4 py-3 font-mono"
                    }, e.user_cod), React.createElement("td", {
                        className: "px-4 py-3 text-right font-semibold"
                    }, er(e.requested_amount)), React.createElement("td", {
                        className: "px-4 py-3 text-right"
                    }, er(e.final_amount)), React.createElement("td", {
                        className: "px-4 py-3"
                    }, React.createElement("span", {
                        className: "text-xs max-w-[120px] truncate"
                    }, e.pix_key)), React.createElement("td", {
                        className: "px-4 py-3 text-center"
                    }, e.has_gratuity ? React.createElement("span", {
                        className: "text-xs font-bold text-emerald-700 bg-emerald-100 px-2 py-1 rounded"
                    }, "SIM") : React.createElement("span", {
                        className: "text-xs text-gray-400"
                    }, "-")), React.createElement("td", {
                        className: "px-4 py-3"
                    }, React.createElement("span", {
                        className: "px-2 py-1 rounded text-xs font-bold " + ("aprovado" === e.status ? "bg-green-500 text-white" : "aprovado_gratuidade" === e.status ? "bg-emerald-500 text-white" : "rejeitado" === e.status ? "bg-red-500 text-white" : "inativo" === e.status ? "bg-orange-500 text-white" : "bg-yellow-500 text-white")
                    }, "aguardando_aprovacao" === e.status ? "⏳ Aguardando" : "aprovado" === e.status ? "✅ Aprovado" : "aprovado_gratuidade" === e.status ? "🎁 c/ Gratuidade" : "rejeitado" === e.status ? "❌ Rejeitado" : "⚠️ Inativo"), e.reject_reason && "rejeitado" === e.status && React.createElement("p", {
                        className: "text-xs text-red-600 mt-1"
                    }, "Motivo: ", e.reject_reason), e.admin_name && "aguardando_aprovacao" !== e.status && React.createElement("p", {
                        className: "text-xs text-purple-600 mt-1 font-medium"
                    }, "👤 ", e.admin_name)))
                }))))))
            })(), !p.searchCod && React.createElement("div", {
                className: "bg-white rounded-xl shadow p-8 text-center"
            }, React.createElement("p", {
                className: "text-gray-500 text-lg"
            }, "🔍 Digite o código do profissional para ver o resumo"))), "gratuidades" === p.finTab && React.createElement("div", {
                className: "space-y-6"
            }, React.createElement("div", {
                className: "bg-white rounded-xl shadow p-6"
            }, React.createElement("h3", {
                className: "text-lg font-semibold mb-4"
            }, "➕ Cadastrar Gratuidade"), React.createElement("div", {
                className: "grid md:grid-cols-2 lg:grid-cols-6 gap-4"
            }, React.createElement("div", null, React.createElement("label", {
                className: "block text-xs font-semibold mb-1 text-gray-600"
            }, "Código *"), React.createElement("input", {
                type: "text",
                placeholder: "Código",
                value: p.gratUserCod || "",
                onChange: async e => {
                    const t = e.target.value;
                    if (x({
                            ...p,
                            gratUserCod: t,
                            gratUserName: ""
                        }), t.length >= 3) {
                        const e = A.find(e => e.codProfissional?.toLowerCase() === t.toLowerCase());
                        e && x(a => ({
                            ...a,
                            gratUserCod: t,
                            gratUserName: e.fullName
                        }))
                    }
                },
                className: "w-full px-4 py-2 border rounded-lg"
            })), React.createElement("div", null, React.createElement("label", {
                className: "block text-xs font-semibold mb-1 text-gray-600"
            }, "Nome"), React.createElement("input", {
                type: "text",
                placeholder: "Nome do usuário",
                value: p.gratUserName || "",
                readOnly: !0,
                className: "w-full px-4 py-2 border rounded-lg bg-gray-50 text-gray-700"
            })), React.createElement("div", null, React.createElement("label", {
                className: "block text-xs font-semibold mb-1 text-gray-600"
            }, "Quantidade *"), React.createElement("input", {
                type: "number",
                placeholder: "Qtd",
                value: p.gratQty || "",
                onChange: e => x({
                    ...p,
                    gratQty: e.target.value
                }),
                className: "w-full px-4 py-2 border rounded-lg"
            })), React.createElement("div", null, React.createElement("label", {
                className: "block text-xs font-semibold mb-1 text-gray-600"
            }, "Valor (R$) *"), React.createElement("input", {
                type: "number",
                placeholder: "Valor",
                value: p.gratValue || "",
                onChange: e => x({
                    ...p,
                    gratValue: e.target.value
                }),
                className: "w-full px-4 py-2 border rounded-lg"
            })), React.createElement("div", null, React.createElement("label", {
                className: "block text-xs font-semibold mb-1 text-gray-600"
            }, "Motivo"), React.createElement("input", {
                type: "text",
                placeholder: "Motivo",
                value: p.gratReason || "",
                onChange: e => x({
                    ...p,
                    gratReason: e.target.value
                }),
                className: "w-full px-4 py-2 border rounded-lg"
            })), React.createElement("div", {
                className: "flex items-end"
            }, React.createElement("button", {
                onClick: Hl,
                disabled: c || !p.gratUserName,
                className: "w-full px-4 py-2 bg-purple-600 text-white rounded-lg font-semibold disabled:opacity-50"
            }, "➕ Adicionar"))), p.gratUserCod && !p.gratUserName && p.gratUserCod.length >= 3 && React.createElement("p", {
                className: "text-red-500 text-xs mt-2"
            }, "⚠️ Usuário não encontrado com este código"), p.gratUserName && React.createElement("p", {
                className: "text-green-600 text-xs mt-2"
            }, "✅ Usuário encontrado: ", p.gratUserName)), React.createElement("div", {
                className: "bg-white rounded-xl shadow overflow-hidden"
            }, React.createElement("table", {
                className: "w-full text-sm"
            }, React.createElement("thead", {
                className: "bg-gray-50"
            }, React.createElement("tr", null, React.createElement("th", {
                className: "px-4 py-3 text-left"
            }, "Código"), React.createElement("th", {
                className: "px-4 py-3 text-left"
            }, "Nome"), React.createElement("th", {
                className: "px-4 py-3 text-center"
            }, "Qtd"), React.createElement("th", {
                className: "px-4 py-3 text-center"
            }, "Rest."), React.createElement("th", {
                className: "px-4 py-3 text-right"
            }, "Valor"), React.createElement("th", {
                className: "px-4 py-3 text-left"
            }, "Motivo"), React.createElement("th", {
                className: "px-4 py-3 text-left"
            }, "Cadastrado por"), React.createElement("th", {
                className: "px-4 py-3 text-center"
            }, "Status"), React.createElement("th", {
                className: "px-4 py-3 text-center"
            }, "Ação"))), React.createElement("tbody", null, Q.map(e => React.createElement("tr", {
                key: e.id,
                className: "border-t " + ("ativa" === e.status ? "bg-green-50" : "")
            }, React.createElement("td", {
                className: "px-4 py-3 font-mono"
            }, e.user_cod), React.createElement("td", {
                className: "px-4 py-3 font-semibold"
            }, e.user_name || "-"), React.createElement("td", {
                className: "px-4 py-3 text-center"
            }, e.quantity), React.createElement("td", {
                className: "px-4 py-3 text-center font-bold"
            }, e.remaining), React.createElement("td", {
                className: "px-4 py-3 text-right"
            }, er(e.value)), React.createElement("td", {
                className: "px-4 py-3"
            }, e.reason || "-"), React.createElement("td", {
                className: "px-4 py-3 text-xs text-gray-600"
            }, e.created_by || "-"), React.createElement("td", {
                className: "px-4 py-3 text-center"
            }, React.createElement("span", {
                className: "px-2 py-1 rounded text-xs font-bold " + ("ativa" === e.status ? "bg-green-500 text-white" : "bg-gray-400 text-white")
            }, e.status)), React.createElement("td", {
                className: "px-4 py-3 text-center"
            }, React.createElement("button", {
                onClick: () => {
                    confirm(`⚠️ Excluir gratuidade de ${e.user_name||e.user_cod}?\n\nValor: ${er(e.value)}\nRestante: ${e.remaining}/${e.quantity}\n\nEsta ação não pode ser desfeita!`) && (async e => {
                        s(!0);
                        try {
                            await fetch(`${API_URL}/gratuities/${e}`, {
                                method: "DELETE"
                            }), ja("🗑️ Gratuidade excluída!", "success"), za()
                        } catch (e) {
                            ja("Erro ao excluir", "error")
                        }
                        s(!1)
                    })(e.id)
                },
                className: "px-3 py-1 bg-red-600 text-white rounded text-xs hover:bg-red-700"
            }, "🗑️ Excluir")))))))), "restritos" === p.finTab && React.createElement("div", {
                className: "space-y-6"
            }, React.createElement("div", {
                className: "bg-white rounded-xl shadow p-6"
            }, React.createElement("h3", {
                className: "text-lg font-semibold mb-4"
            }, "➕ Adicionar Restrição"), React.createElement("div", {
                className: "grid md:grid-cols-4 gap-4"
            }, React.createElement("div", null, React.createElement("label", {
                className: "block text-xs font-semibold mb-1 text-gray-600"
            }, "Código *"), React.createElement("input", {
                type: "text",
                placeholder: "Código",
                value: p.restUserCod || "",
                onChange: async e => {
                    const t = e.target.value;
                    if (x({
                            ...p,
                            restUserCod: t,
                            restUserName: ""
                        }), t.length >= 3) {
                        const e = A.find(e => e.codProfissional?.toLowerCase() === t.toLowerCase());
                        e && x(a => ({
                            ...a,
                            restUserCod: t,
                            restUserName: e.fullName
                        }))
                    }
                },
                className: "w-full px-4 py-2 border rounded-lg"
            })), React.createElement("div", null, React.createElement("label", {
                className: "block text-xs font-semibold mb-1 text-gray-600"
            }, "Nome"), React.createElement("input", {
                type: "text",
                placeholder: "Nome do usuário",
                value: p.restUserName || "",
                readOnly: !0,
                className: "w-full px-4 py-2 border rounded-lg bg-gray-50 text-gray-700"
            })), React.createElement("div", null, React.createElement("label", {
                className: "block text-xs font-semibold mb-1 text-gray-600"
            }, "Motivo *"), React.createElement("input", {
                type: "text",
                placeholder: "Motivo",
                value: p.restReason || "",
                onChange: e => x({
                    ...p,
                    restReason: e.target.value
                }),
                className: "w-full px-4 py-2 border rounded-lg"
            })), React.createElement("div", {
                className: "flex items-end"
            }, React.createElement("button", {
                onClick: Gl,
                disabled: c || !p.restUserName,
                className: "w-full px-4 py-2 bg-red-600 text-white rounded-lg font-semibold disabled:opacity-50"
            }, "🚫 Adicionar"))), p.restUserCod && !p.restUserName && p.restUserCod.length >= 3 && React.createElement("p", {
                className: "text-red-500 text-xs mt-2"
            }, "⚠️ Usuário não encontrado com este código"), p.restUserName && React.createElement("p", {
                className: "text-green-600 text-xs mt-2"
            }, "✅ Usuário encontrado: ", p.restUserName)), React.createElement("div", {
                className: "bg-white rounded-xl shadow overflow-hidden"
            }, React.createElement("table", {
                className: "w-full text-sm"
            }, React.createElement("thead", {
                className: "bg-gray-50"
            }, React.createElement("tr", null, React.createElement("th", {
                className: "px-4 py-3 text-left"
            }, "Código"), React.createElement("th", {
                className: "px-4 py-3 text-left"
            }, "Nome"), React.createElement("th", {
                className: "px-4 py-3 text-left"
            }, "Motivo"), React.createElement("th", {
                className: "px-4 py-3 text-left"
            }, "Cadastrado por"), React.createElement("th", {
                className: "px-4 py-3 text-left"
            }, "Data"), React.createElement("th", {
                className: "px-4 py-3 text-center"
            }, "Status"), React.createElement("th", {
                className: "px-4 py-3 text-center"
            }, "Ação"))), React.createElement("tbody", null, Z.map(e => React.createElement("tr", {
                key: e.id,
                className: "border-t " + ("ativo" === e.status ? "bg-red-50" : "")
            }, React.createElement("td", {
                className: "px-4 py-3 font-mono"
            }, e.user_cod), React.createElement("td", {
                className: "px-4 py-3 font-semibold"
            }, e.user_name || "-"), React.createElement("td", {
                className: "px-4 py-3"
            }, e.reason), React.createElement("td", {
                className: "px-4 py-3 text-xs text-gray-600"
            }, e.created_by || "-"), React.createElement("td", {
                className: "px-4 py-3"
            }, new Date(e.created_at).toLocaleDateString("pt-BR")), React.createElement("td", {
                className: "px-4 py-3 text-center"
            }, React.createElement("span", {
                className: "px-2 py-1 rounded text-xs font-bold " + ("ativo" === e.status ? "bg-red-500 text-white" : "bg-gray-400 text-white")
            }, e.status)), React.createElement("td", {
                className: "px-4 py-3 text-center"
            }, "ativo" === e.status && React.createElement("button", {
                onClick: () => (async e => {
                    try {
                        await fetch(`${API_URL}/restricted/${e}/remove`, {
                            method: "PATCH",
                            headers: {
                                "Content-Type": "application/json"
                            },
                            body: JSON.stringify({
                                removedReason: "Suspensa pelo admin"
                            })
                        }), ja("✅ Restrição removida!", "success"), Ba()
                    } catch (e) {
                        ja("Erro", "error")
                    }
                })(e.id),
                className: "px-3 py-1 bg-green-600 text-white rounded text-xs"
            }, "Suspender")))))))), "indicacoes" === p.finTab && React.createElement(React.Fragment, null, p.modalRejeitar && React.createElement("div", {
                className: "fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4"
            }, React.createElement("div", {
                className: "bg-white rounded-xl shadow-2xl p-6 max-w-md w-full"
            }, React.createElement("h3", {
                className: "text-xl font-bold text-red-600 mb-4"
            }, "❌ Rejeitar Indicação"), React.createElement("div", {
                className: "bg-gray-50 rounded-lg p-4 mb-4"
            }, React.createElement("p", {
                className: "text-sm"
            }, React.createElement("strong", null, "Profissional:"), " ", p.modalRejeitar.user_name), React.createElement("p", {
                className: "text-sm"
            }, React.createElement("strong", null, "Indicado:"), " ", p.modalRejeitar.indicado_nome), React.createElement("p", {
                className: "text-sm"
            }, React.createElement("strong", null, "Região:"), " ", p.modalRejeitar.regiao)), React.createElement("div", {
                className: "mb-4"
            }, React.createElement("label", {
                className: "block text-sm font-semibold mb-1"
            }, "Motivo da Rejeição *"), React.createElement("textarea", {
                value: p.motivoRejeicao || "",
                onChange: e => x({
                    ...p,
                    motivoRejeicao: e.target.value
                }),
                className: "w-full px-4 py-2 border rounded-lg",
                rows: "3",
                placeholder: "Informe o motivo..."
            })), React.createElement("div", {
                className: "flex gap-3"
            }, React.createElement("button", {
                onClick: () => x({
                    ...p,
                    modalRejeitar: null,
                    motivoRejeicao: ""
                }),
                className: "flex-1 px-4 py-2 bg-gray-200 text-gray-700 rounded-lg font-semibold hover:bg-gray-300"
            }, "Cancelar"), React.createElement("button", {
                onClick: () => (async e => {
                    if (p.motivoRejeicao) {
                        s(!0);
                        try {
                            if (!(await fetch(`${API_URL}/indicacoes/${e}/rejeitar`, {
                                    method: "PATCH",
                                    headers: {
                                        "Content-Type": "application/json"
                                    },
                                    body: JSON.stringify({
                                        motivo_rejeicao: p.motivoRejeicao,
                                        resolved_by: l.fullName
                                    })
                                })).ok) throw new Error("Erro ao rejeitar");
                            ja("❌ Indicação rejeitada", "success"), x({
                                ...p,
                                modalRejeitar: null,
                                motivoRejeicao: ""
                            }), await wl()
                        } catch (e) {
                            ja(e.message, "error")
                        }
                        s(!1)
                    } else ja("Informe o motivo da rejeição", "error")
                })(p.modalRejeitar.id),
                disabled: !p.motivoRejeicao || c,
                className: "flex-1 px-4 py-2 bg-red-600 text-white rounded-lg font-semibold hover:bg-red-700 disabled:opacity-50"
            }, c ? "..." : "❌ Rejeitar")))), React.createElement("div", {
                className: "bg-white rounded-xl shadow p-6 mb-6"
            }, React.createElement("div", {
                className: "flex justify-between items-center mb-4"
            }, React.createElement("h2", {
                className: "text-xl font-bold text-green-800"
            }, p.editPromo ? "✏️ Editar Promoção" : "📣 Cadastrar Nova Promoção"), p.editPromo && React.createElement("button", {
                onClick: () => x({
                    ...p,
                    editPromo: null,
                    promoRegiao: "",
                    promoValor: "",
                    promoDetalhes: ""
                }),
                className: "text-sm text-gray-500 hover:text-gray-700"
            }, "✕ Cancelar edição")), React.createElement("div", {
                className: "grid md:grid-cols-2 gap-4 mb-4"
            }, React.createElement("div", null, React.createElement("label", {
                className: "block text-sm font-semibold mb-1"
            }, "Região *"), React.createElement("input", {
                type: "text",
                value: p.promoRegiao || "",
                onChange: e => x({
                    ...p,
                    promoRegiao: e.target.value
                }),
                className: "w-full px-4 py-2 border rounded-lg",
                placeholder: "Ex: Salvador - BA"
            })), React.createElement("div", null, React.createElement("label", {
                className: "block text-sm font-semibold mb-1"
            }, "Valor do Bônus (R$) *"), React.createElement("input", {
                type: "number",
                step: "0.01",
                value: p.promoValor || "",
                onChange: e => x({
                    ...p,
                    promoValor: e.target.value
                }),
                className: "w-full px-4 py-2 border rounded-lg",
                placeholder: "Ex: 100.00"
            }))), React.createElement("div", {
                className: "mb-4"
            }, React.createElement("label", {
                className: "block text-sm font-semibold mb-1"
            }, "Detalhes da Promoção (opcional)"), React.createElement("textarea", {
                value: p.promoDetalhes || "",
                onChange: e => x({
                    ...p,
                    promoDetalhes: e.target.value
                }),
                className: "w-full px-4 py-2 border rounded-lg",
                rows: "3",
                placeholder: "Ex: Vaga para instalador com experiência em fibra óptica. Início imediato. Benefícios: vale transporte + alimentação..."
            })), React.createElement("button", {
                onClick: p.editPromo ? Ol : Ml,
                disabled: c,
                className: "w-full md:w-auto px-6 py-2 text-white rounded-lg font-semibold disabled:opacity-50 " + (p.editPromo ? "bg-blue-600 hover:bg-blue-700" : "bg-green-600 hover:bg-green-700")
            }, c ? "..." : p.editPromo ? "💾 Salvar Alterações" : "➕ Criar Promoção")), React.createElement("div", {
                className: "bg-white rounded-xl shadow p-6 mb-6"
            }, React.createElement("h3", {
                className: "font-semibold mb-4"
            }, "📋 Promoções Cadastradas"), 0 === ee.length ? React.createElement("p", {
                className: "text-gray-500 text-center py-4"
            }, "Nenhuma promoção cadastrada") : React.createElement("div", {
                className: "grid md:grid-cols-4 gap-3"
            }, ee.map(e => React.createElement("div", {
                key: e.id,
                className: "border rounded-lg p-3 " + ("ativa" === e.status ? "border-green-300 bg-green-50" : "border-gray-300 bg-gray-50")
            }, React.createElement("div", {
                className: "flex justify-between items-center mb-1"
            }, React.createElement("span", {
                className: "px-2 py-0.5 rounded text-xs font-bold " + ("ativa" === e.status ? "bg-green-500 text-white" : "bg-gray-500 text-white")
            }, "ativa" === e.status ? "✅" : "⏸️"), React.createElement("div", {
                className: "flex gap-1"
            }, React.createElement("button", {
                onClick: () => x({
                    ...p,
                    editPromo: e,
                    promoRegiao: e.regiao,
                    promoValor: e.valor_bonus,
                    promoDetalhes: e.detalhes || ""
                }),
                className: "text-xs text-blue-500 hover:text-blue-700"
            }, "✏️"), React.createElement("button", {
                onClick: async () => {
                    await fetch(`${API_URL}/promocoes/${e.id}`, {
                        method: "PATCH",
                        headers: {
                            "Content-Type": "application/json"
                        },
                        body: JSON.stringify({
                            status: "ativa" === e.status ? "inativa" : "ativa"
                        })
                    }), gl()
                },
                className: "text-xs text-gray-500 hover:text-gray-700"
            }, "ativa" === e.status ? "⏸️" : "▶️"))), React.createElement("p", {
                className: "font-semibold text-sm"
            }, "📍 ", e.regiao), React.createElement("p", {
                className: "text-lg font-bold text-green-600"
            }, er(e.valor_bonus)), e.detalhes && React.createElement("p", {
                className: "text-xs text-gray-600 mt-1 whitespace-pre-wrap line-clamp-3",
                title: e.detalhes
            }, e.detalhes))))), React.createElement("div", {
                className: "grid grid-cols-2 md:grid-cols-4 gap-4 mb-6"
            }, React.createElement("div", {
                className: "bg-yellow-50 border border-yellow-200 rounded-xl p-4 text-center"
            }, React.createElement("p", {
                className: "text-3xl font-bold text-yellow-600"
            }, ae.filter(e => "pendente" === e.status).length), React.createElement("p", {
                className: "text-sm text-yellow-700"
            }, "Pendentes")), React.createElement("div", {
                className: "bg-green-50 border border-green-200 rounded-xl p-4 text-center"
            }, React.createElement("p", {
                className: "text-3xl font-bold text-green-600"
            }, ae.filter(e => "aprovada" === e.status).length), React.createElement("p", {
                className: "text-sm text-green-700"
            }, "Aprovadas")), React.createElement("div", {
                className: "bg-red-50 border border-red-200 rounded-xl p-4 text-center"
            }, React.createElement("p", {
                className: "text-3xl font-bold text-red-600"
            }, ae.filter(e => "rejeitada" === e.status).length), React.createElement("p", {
                className: "text-sm text-red-700"
            }, "Rejeitadas")), React.createElement("div", {
                className: "bg-gray-50 border border-gray-200 rounded-xl p-4 text-center"
            }, React.createElement("p", {
                className: "text-3xl font-bold text-gray-600"
            }, ae.filter(e => "expirada" === e.status).length), React.createElement("p", {
                className: "text-sm text-gray-700"
            }, "Expiradas"))), React.createElement("div", {
                className: "bg-white rounded-xl shadow p-6"
            }, React.createElement("h3", {
                className: "font-semibold mb-4"
            }, "👥 Indicações Recebidas"), 0 === ae.length ? React.createElement("p", {
                className: "text-gray-500 text-center py-8"
            }, "Nenhuma indicação recebida") : React.createElement("div", {
                className: "overflow-x-auto"
            }, React.createElement("table", {
                className: "w-full text-sm"
            }, React.createElement("thead", {
                className: "bg-gray-50"
            }, React.createElement("tr", null, React.createElement("th", {
                className: "px-2 py-3 text-left text-xs"
            }, "Data"), React.createElement("th", {
                className: "px-2 py-3 text-left text-xs"
            }, "Profissional"), React.createElement("th", {
                className: "px-2 py-3 text-left text-xs"
            }, "Indicado"), React.createElement("th", {
                className: "px-2 py-3 text-left text-xs"
            }, "Contato"), React.createElement("th", {
                className: "px-2 py-3 text-left text-xs"
            }, "Região"), React.createElement("th", {
                className: "px-2 py-3 text-center text-xs"
            }, "Bônus"), React.createElement("th", {
                className: "px-2 py-3 text-center text-xs"
            }, "Expira"), React.createElement("th", {
                className: "px-3 py-3 text-center"
            }, "Status"), React.createElement("th", {
                className: "px-3 py-3 text-center"
            }, "Crédito Lançado"), React.createElement("th", {
                className: "px-3 py-3 text-center"
            }, "Ações"))), React.createElement("tbody", null, ae.map(e => {
                const t = Math.ceil((new Date(e.expires_at) - new Date) / 864e5),
                    a = e.indicado_contato ? e.indicado_contato.replace(/\D/g, "") : "",
                    r = a ? `https://wa.me/55${a}` : "#";
                return React.createElement("tr", {
                    key: e.id,
                    className: "border-t " + ("pendente" === e.status ? "bg-yellow-50" : "")
                }, React.createElement("td", {
                    className: "px-2 py-3 whitespace-nowrap text-xs"
                }, new Date(e.created_at).toLocaleDateString("pt-BR")), React.createElement("td", {
                    className: "px-2 py-3"
                }, React.createElement("p", {
                    className: "font-semibold text-xs"
                }, e.user_name), React.createElement("p", {
                    className: "text-xs text-gray-500"
                }, e.user_cod)), React.createElement("td", {
                    className: "px-2 py-3"
                }, React.createElement("p", {
                    className: "font-semibold text-xs"
                }, e.indicado_nome), e.indicado_cpf && React.createElement("p", {
                    className: "text-xs text-gray-500"
                }, e.indicado_cpf)), React.createElement("td", {
                    className: "px-2 py-3"
                }, React.createElement("a", {
                    href: r,
                    target: "_blank",
                    rel: "noopener noreferrer",
                    className: "text-green-600 hover:text-green-800 font-semibold text-xs flex items-center gap-1"
                }, "📱 ", e.indicado_contato)), React.createElement("td", {
                    className: "px-2 py-3 text-xs"
                }, e.regiao), React.createElement("td", {
                    className: "px-2 py-3 text-center font-bold text-green-600 text-xs"
                }, er(e.valor_bonus)), React.createElement("td", {
                    className: "px-2 py-3 text-center"
                }, "pendente" === e.status ? React.createElement("span", {
                    className: "text-xs font-bold " + (t <= 5 ? "text-red-600" : "text-gray-600")
                }, t > 0 ? `${t}d` : "Exp") : "-"), React.createElement("td", {
                    className: "px-3 py-3 text-center"
                }, React.createElement("div", {
                    className: "flex flex-col items-center"
                }, React.createElement("span", {
                    className: "px-2 py-1 rounded-full text-xs font-bold " + ("pendente" === e.status ? "bg-yellow-500 text-white" : "aprovada" === e.status ? "bg-green-500 text-white" : "rejeitada" === e.status ? "bg-red-500 text-white" : "bg-gray-500 text-white")
                }, "pendente" === e.status ? "⏳ Pendente" : "aprovada" === e.status ? "✅ Aprovada" : "rejeitada" === e.status ? "❌ Rejeitada" : "⏰ Expirada"), ("aprovada" === e.status || "rejeitada" === e.status) && e.resolved_by && React.createElement("span", {
                    className: "text-xs text-gray-500 mt-1"
                }, e.resolved_by))), React.createElement("td", {
                    className: "px-3 py-3 text-center"
                }, "aprovada" === e.status && React.createElement("div", {
                    className: "flex flex-col items-center"
                }, React.createElement("input", {
                    type: "checkbox",
                    checked: e.credito_lancado || !1,
                    onChange: async t => {
                        try {
                            await fetch(`${API_URL}/indicacoes/${e.id}/credito`, {
                                method: "PATCH",
                                headers: {
                                    "Content-Type": "application/json"
                                },
                                body: JSON.stringify({
                                    credito_lancado: t.target.checked,
                                    lancado_por: l.fullName
                                })
                            }), wl()
                        } catch (e) {
                            ja("Erro ao atualizar", "error")
                        }
                    },
                    className: "w-5 h-5 cursor-pointer"
                }), e.credito_lancado && e.lancado_por && React.createElement("span", {
                    className: "text-xs text-gray-500 mt-1"
                }, e.lancado_por))), React.createElement("td", {
                    className: "px-3 py-3 text-center"
                }, "pendente" === e.status && React.createElement("div", {
                    className: "flex gap-2 justify-center"
                }, React.createElement("button", {
                    onClick: () => (async e => {
                        s(!0);
                        try {
                            if (!(await fetch(`${API_URL}/indicacoes/${e}/aprovar`, {
                                    method: "PATCH",
                                    headers: {
                                        "Content-Type": "application/json"
                                    },
                                    body: JSON.stringify({
                                        resolved_by: l.fullName
                                    })
                                })).ok) throw new Error("Erro ao aprovar");
                            ja("✅ Indicação aprovada!", "success"), await wl()
                        } catch (e) {
                            ja(e.message, "error")
                        }
                        s(!1)
                    })(e.id),
                    className: "px-3 py-1 bg-green-600 text-white rounded text-xs hover:bg-green-700"
                }, "✅ Aprovar"), React.createElement("button", {
                    onClick: () => x({
                        ...p,
                        modalRejeitar: e
                    }),
                    className: "px-3 py-1 bg-red-600 text-white rounded text-xs hover:bg-red-700"
                }, "❌ Rejeitar")), "rejeitada" === e.status && e.motivo_rejeicao && React.createElement("span", {
                    className: "text-xs text-red-600",
                    title: e.motivo_rejeicao
                }, "📝 ", e.motivo_rejeicao.substring(0, 20), "...")))
            })))))), "promo-novatos" === p.finTab && React.createElement(React.Fragment, null, p.modalRejeitarNovatos && React.createElement("div", {
                className: "fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4"
            }, React.createElement("div", {
                className: "bg-white rounded-xl p-6 w-full max-w-md"
            }, React.createElement("h3", {
                className: "text-lg font-bold mb-4"
            }, "❌ Rejeitar Inscrição"), React.createElement("p", {
                className: "text-sm text-gray-600 mb-3"
            }, "Profissional: ", React.createElement("strong", null, p.modalRejeitarNovatos.user_name), React.createElement("br", null), "Cliente: ", React.createElement("strong", null, p.modalRejeitarNovatos.cliente)), React.createElement("div", {
                className: "mb-4"
            }, React.createElement("label", {
                className: "block text-sm font-semibold mb-1"
            }, "Motivo da Rejeição *"), React.createElement("textarea", {
                value: p.motivoRejeicaoNovato || "",
                onChange: e => x({
                    ...p,
                    motivoRejeicaoNovato: e.target.value
                }),
                className: "w-full px-4 py-2 border rounded-lg",
                rows: "3",
                placeholder: "Informe o motivo..."
            })), React.createElement("div", {
                className: "flex gap-3"
            }, React.createElement("button", {
                onClick: () => x({
                    ...p,
                    modalRejeitarNovatos: null,
                    motivoRejeicaoNovato: ""
                }),
                className: "flex-1 px-4 py-2 bg-gray-200 text-gray-700 rounded-lg font-semibold hover:bg-gray-300"
            }, "Cancelar"), React.createElement("button", {
                onClick: () => handleRejeitarInscricaoNovato(p.modalRejeitarNovatos.id),
                disabled: !p.motivoRejeicaoNovato || c,
                className: "flex-1 px-4 py-2 bg-red-600 text-white rounded-lg font-semibold hover:bg-red-700 disabled:opacity-50"
            }, c ? "..." : "❌ Rejeitar")))), React.createElement("div", {
                className: "bg-gradient-to-r from-purple-600 to-purple-800 rounded-xl shadow-lg mb-6 text-white overflow-hidden"
            }, React.createElement("div", {
                className: "p-4 flex justify-between items-center cursor-pointer hover:bg-white/10 transition",
                onClick: () => $e(!Fe)
            }, React.createElement("div", {
                className: "flex items-center gap-3"
            }, React.createElement("span", {
                className: "text-2xl"
            }, "🎯"), React.createElement("div", null, React.createElement("h2", {
                className: "text-lg font-bold"
            }, "Quiz de Procedimentos"), React.createElement("p", {
                className: "text-purple-200 text-xs"
            }, "Clique para ", Fe ? "recolher" : "expandir", " configurações"))), React.createElement("div", {
                className: "flex items-center gap-3"
            }, React.createElement("span", {
                className: "px-3 py-1 rounded-full text-xs font-bold " + (fe.ativo ? "bg-green-500" : "bg-red-500")
            }, fe.ativo ? "✅ ATIVO" : "❌ INATIVO"), React.createElement("span", {
                className: "text-2xl transition-transform",
                style: {
                    transform: Fe ? "rotate(180deg)" : "rotate(0deg)"
                }
            }, "▼"))), Fe && React.createElement("div", {
                className: "p-6 pt-2 border-t border-white/20"
            }, React.createElement("div", {
                className: "flex justify-end mb-4"
            }, React.createElement("button", {
                onClick: () => Ne({
                    ...fe,
                    ativo: !fe.ativo
                }),
                className: "px-4 py-2 rounded-lg font-semibold text-sm " + (fe.ativo ? "bg-red-500 hover:bg-red-600" : "bg-green-500 hover:bg-green-600")
            }, fe.ativo ? "⏸️ Desativar Quiz" : "▶️ Ativar Quiz")), React.createElement("div", {
                className: "grid md:grid-cols-2 gap-4 mb-4"
            }, React.createElement("div", null, React.createElement("label", {
                className: "block text-sm font-semibold mb-1"
            }, "Título da Promoção"), React.createElement("input", {
                type: "text",
                value: fe.titulo,
                onChange: e => Ne({
                    ...fe,
                    titulo: e.target.value
                }),
                className: "w-full px-4 py-2 border rounded-lg text-gray-800",
                placeholder: "Acerte os procedimentos..."
            })), React.createElement("div", null, React.createElement("label", {
                className: "block text-sm font-semibold mb-1"
            }, "Valor da Gratuidade (R$)"), React.createElement("input", {
                type: "number",
                step: "0.01",
                value: fe.valor_gratuidade,
                onChange: e => Ne({
                    ...fe,
                    valor_gratuidade: parseFloat(e.target.value) || 0
                }),
                className: "w-full px-4 py-2 border rounded-lg text-gray-800"
            }))), React.createElement("div", {
                className: "mb-4"
            }, React.createElement("label", {
                className: "block text-sm font-semibold mb-2"
            }, "📸 4 Imagens do Carrossel"), React.createElement("div", {
                className: "grid grid-cols-2 md:grid-cols-4 gap-3"
            }, [0, 1, 2, 3].map(e => React.createElement("div", {
                key: e,
                className: "relative"
            }, React.createElement("div", {
                className: "aspect-video bg-white/20 rounded-lg overflow-hidden border-2 border-dashed border-white/50 flex items-center justify-center"
            }, fe.imagens[e] ? React.createElement("img", {
                src: fe.imagens[e],
                alt: `Imagem ${e+1}`,
                className: "w-full h-full object-cover"
            }) : React.createElement("span", {
                className: "text-white/70 text-sm"
            }, "Imagem ", e + 1)), React.createElement("input", {
                type: "file",
                accept: "image/*",
                onChange: t => (async (e, t) => {
                    if (!t) return;
                    const a = new FileReader;
                    a.onload = t => {
                        const a = [...fe.imagens];
                        a[e] = t.target.result, Ne({
                            ...fe,
                            imagens: a
                        })
                    }, a.readAsDataURL(t)
                })(e, t.target.files[0]),
                className: "absolute inset-0 opacity-0 cursor-pointer"
            }), fe.imagens[e] && React.createElement("button", {
                onClick: () => {
                    const t = [...fe.imagens];
                    t[e] = null, Ne({
                        ...fe,
                        imagens: t
                    })
                },
                className: "absolute top-1 right-1 w-6 h-6 bg-red-500 text-white rounded-full text-xs hover:bg-red-600"
            }, "✕"))))), React.createElement("div", {
                className: "mb-4"
            }, React.createElement("label", {
                className: "block text-sm font-semibold mb-2"
            }, "❓ 5 Afirmações (CERTO ou ERRADO)"), React.createElement("div", {
                className: "space-y-3"
            }, [0, 1, 2, 3, 4].map(e => React.createElement("div", {
                key: e,
                className: "flex gap-3 items-center bg-white/10 rounded-lg p-3"
            }, React.createElement("span", {
                className: "font-bold text-lg"
            }, e + 1, "."), React.createElement("input", {
                type: "text",
                value: fe.perguntas[e]?.texto || "",
                onChange: t => {
                    const a = [...fe.perguntas];
                    a[e] = {
                        ...a[e],
                        texto: t.target.value
                    }, Ne({
                        ...fe,
                        perguntas: a
                    })
                },
                className: "flex-1 px-3 py-2 border rounded-lg text-gray-800",
                placeholder: `Afirmação ${e+1}...`
            }), React.createElement("div", {
                className: "flex gap-2"
            }, React.createElement("button", {
                onClick: () => {
                    const t = [...fe.perguntas];
                    t[e] = {
                        ...t[e],
                        resposta: !0
                    }, Ne({
                        ...fe,
                        perguntas: t
                    })
                },
                className: "px-3 py-2 rounded-lg font-semibold text-sm " + (!0 === fe.perguntas[e]?.resposta ? "bg-green-500" : "bg-white/20 hover:bg-white/30")
            }, "CERTO"), React.createElement("button", {
                onClick: () => {
                    const t = [...fe.perguntas];
                    t[e] = {
                        ...t[e],
                        resposta: !1
                    }, Ne({
                        ...fe,
                        perguntas: t
                    })
                },
                className: "px-3 py-2 rounded-lg font-semibold text-sm " + (!1 === fe.perguntas[e]?.resposta ? "bg-red-500" : "bg-white/20 hover:bg-white/30")
            }, "ERRADO")))))), React.createElement("button", {
                onClick: Fl,
                disabled: c,
                className: "w-full py-3 bg-white text-purple-700 rounded-lg font-bold hover:bg-purple-50 disabled:opacity-50"
            }, c ? "Salvando..." : "💾 Salvar Configuração do Quiz"))), React.createElement("div", {
                className: "bg-white rounded-xl shadow p-6 mb-6"
            }, React.createElement("div", {
                className: "flex justify-between items-center mb-4"
            }, React.createElement("h3", {
                className: "font-bold text-lg text-purple-700"
            }, "📊 Histórico do Quiz"), React.createElement("div", {
                className: "flex gap-2"
            }, React.createElement("span", {
                className: "px-3 py-1 bg-blue-100 text-blue-700 rounded-full text-sm font-bold"
            }, ye.length, " participantes"), React.createElement("span", {
                className: "px-3 py-1 bg-green-100 text-green-700 rounded-full text-sm font-bold"
            }, ye.filter(e => e.passou).length, " contemplados"))), React.createElement("div", {
                className: "grid grid-cols-4 gap-3 mb-4"
            }, React.createElement("div", {
                className: "bg-blue-50 border border-blue-200 rounded-lg p-3 text-center"
            }, React.createElement("p", {
                className: "text-2xl font-bold text-blue-600"
            }, ye.length), React.createElement("p", {
                className: "text-xs text-blue-700"
            }, "Total")), React.createElement("div", {
                className: "bg-green-50 border border-green-200 rounded-lg p-3 text-center"
            }, React.createElement("p", {
                className: "text-2xl font-bold text-green-600"
            }, ye.filter(e => e.passou).length), React.createElement("p", {
                className: "text-xs text-green-700"
            }, "Contemplados")), React.createElement("div", {
                className: "bg-red-50 border border-red-200 rounded-lg p-3 text-center"
            }, React.createElement("p", {
                className: "text-2xl font-bold text-red-600"
            }, ye.filter(e => !e.passou).length), React.createElement("p", {
                className: "text-xs text-red-700"
            }, "Não passou")), React.createElement("div", {
                className: "bg-purple-50 border border-purple-200 rounded-lg p-3 text-center"
            }, React.createElement("p", {
                className: "text-2xl font-bold text-purple-600"
            }, er(ye.filter(e => e.passou).length * (fe.valor_gratuidade || 500))), React.createElement("p", {
                className: "text-xs text-purple-700"
            }, "Total Gratuidades"))), 0 === ye.length ? React.createElement("p", {
                className: "text-gray-500 text-center py-8"
            }, "Nenhum participante ainda") : React.createElement("div", {
                className: "overflow-x-auto max-h-80"
            }, React.createElement("table", {
                className: "w-full text-sm"
            }, React.createElement("thead", {
                className: "bg-gray-100 sticky top-0"
            }, React.createElement("tr", null, React.createElement("th", {
                className: "px-3 py-2 text-left font-semibold"
            }, "Data/Hora"), React.createElement("th", {
                className: "px-3 py-2 text-left font-semibold"
            }, "Profissional"), React.createElement("th", {
                className: "px-3 py-2 text-left font-semibold"
            }, "COD"), React.createElement("th", {
                className: "px-3 py-2 text-center font-semibold"
            }, "Acertos"), React.createElement("th", {
                className: "px-3 py-2 text-center font-semibold"
            }, "Resultado"), React.createElement("th", {
                className: "px-3 py-2 text-center font-semibold"
            }, "Gratuidade"))), React.createElement("tbody", null, ye.map(e => React.createElement("tr", {
                key: e.id,
                className: "border-b hover:bg-gray-50 " + (e.passou ? "bg-green-50" : "")
            }, React.createElement("td", {
                className: "px-3 py-2 text-xs text-gray-600"
            }, new Date(e.created_at).toLocaleDateString("pt-BR"), " ", new Date(e.created_at).toLocaleTimeString("pt-BR", {
                hour: "2-digit",
                minute: "2-digit"
            })), React.createElement("td", {
                className: "px-3 py-2 font-medium"
            }, e.user_name), React.createElement("td", {
                className: "px-3 py-2 text-gray-600"
            }, e.user_cod), React.createElement("td", {
                className: "px-3 py-2 text-center"
            }, React.createElement("span", {
                className: "font-bold " + (5 === e.acertos ? "text-green-600" : "text-red-600")
            }, e.acertos, "/5")), React.createElement("td", {
                className: "px-3 py-2 text-center"
            }, React.createElement("span", {
                className: "px-2 py-1 rounded-full text-xs font-bold " + (e.passou ? "bg-green-500 text-white" : "bg-red-400 text-white")
            }, e.passou ? "✅ Contemplado" : "❌ Não passou")), React.createElement("td", {
                className: "px-3 py-2 text-center"
            }, e.passou ? React.createElement("span", {
                className: "font-bold text-green-600"
            }, er(fe.valor_gratuidade || 500)) : React.createElement("span", {
                className: "text-gray-400"
            }, "-")))))))), React.createElement("hr", {
                className: "my-6 border-gray-300"
            }), React.createElement("h3", {
                className: "text-lg font-bold text-gray-700 mb-4"
            }, "📋 Promoções por Cliente/Região"), React.createElement("div", {
                className: "bg-white rounded-xl shadow p-6 mb-6"
            }, React.createElement("div", {
                className: "flex justify-between items-center mb-4"
            }, React.createElement("h2", {
                className: "text-xl font-bold text-green-800"
            }, p.editPromoNovatos ? "✏️ Editar Promoção Novatos" : "🚀 Cadastrar Nova Promoção Novatos"), p.editPromoNovatos && React.createElement("button", {
                onClick: () => x({
                    ...p,
                    editPromoNovatos: null,
                    novatosRegiao: "",
                    novatosCliente: "",
                    novatosValor: "",
                    novatosDetalhes: ""
                }),
                className: "text-sm text-gray-500 hover:text-gray-700"
            }, "✕ Cancelar edição")), React.createElement("div", {
                className: "grid md:grid-cols-3 gap-4 mb-4"
            }, React.createElement("div", null, React.createElement("label", {
                className: "block text-sm font-semibold mb-1"
            }, "Região *"), React.createElement("input", {
                type: "text",
                value: p.novatosRegiao || "",
                onChange: e => x({
                    ...p,
                    novatosRegiao: e.target.value
                }),
                className: "w-full px-4 py-2 border rounded-lg",
                placeholder: "Ex: Salvador - BA"
            })), React.createElement("div", null, React.createElement("label", {
                className: "block text-sm font-semibold mb-1"
            }, "Cliente *"), React.createElement("input", {
                type: "text",
                value: p.novatosCliente || "",
                onChange: e => x({
                    ...p,
                    novatosCliente: e.target.value
                }),
                className: "w-full px-4 py-2 border rounded-lg",
                placeholder: "Ex: Magazine Luiza"
            })), React.createElement("div", null, React.createElement("label", {
                className: "block text-sm font-semibold mb-1"
            }, "Valor do Bônus (R$) *"), React.createElement("input", {
                type: "number",
                step: "0.01",
                value: p.novatosValor || "",
                onChange: e => x({
                    ...p,
                    novatosValor: e.target.value
                }),
                className: "w-full px-4 py-2 border rounded-lg",
                placeholder: "Ex: 150.00"
            }))), React.createElement("div", {
                className: "mb-4"
            }, React.createElement("label", {
                className: "block text-sm font-semibold mb-1"
            }, "Detalhes da Promoção (opcional)"), React.createElement("textarea", {
                value: p.novatosDetalhes || "",
                onChange: e => x({
                    ...p,
                    novatosDetalhes: e.target.value
                }),
                className: "w-full px-4 py-2 border rounded-lg",
                rows: "3",
                placeholder: "Ex: Vaga para motoboy com moto própria. Início imediato..."
            })), React.createElement("div", {
                className: "flex items-center gap-4"
            }, React.createElement("button", {
                onClick: p.editPromoNovatos ? Tl : Pl,
                disabled: c,
                className: "px-6 py-2 text-white rounded-lg font-semibold disabled:opacity-50 " + (p.editPromoNovatos ? "bg-blue-600 hover:bg-blue-700" : "bg-green-600 hover:bg-green-700")
            }, c ? "..." : p.editPromoNovatos ? "💾 Salvar Alterações" : "➕ Criar Promoção"), React.createElement("p", {
                className: "text-xs text-gray-500"
            }, "⏱️ Inscrições expiram automaticamente em 10 dias"))), React.createElement("div", {
                className: "bg-white rounded-xl shadow p-6 mb-6"
            }, React.createElement("h3", {
                className: "font-semibold mb-4"
            }, "📋 Promoções Novatos Cadastradas"), 0 === ce.length ? React.createElement("p", {
                className: "text-gray-500 text-center py-4"
            }, "Nenhuma promoção cadastrada") : React.createElement("div", {
                className: "grid md:grid-cols-3 gap-3"
            }, ce.map(e => React.createElement("div", {
                key: e.id,
                className: "border rounded-lg p-3 " + ("ativa" === e.status ? "border-green-300 bg-green-50" : "border-gray-300 bg-gray-50")
            }, React.createElement("div", {
                className: "flex justify-between items-center mb-1"
            }, React.createElement("span", {
                className: "px-2 py-0.5 rounded text-xs font-bold " + ("ativa" === e.status ? "bg-green-500 text-white" : "bg-gray-500 text-white")
            }, "ativa" === e.status ? "✅" : "⏸️"), React.createElement("div", {
                className: "flex gap-1"
            }, React.createElement("button", {
                onClick: () => x({
                    ...p,
                    editPromoNovatos: e,
                    novatosRegiao: e.regiao,
                    novatosCliente: e.cliente,
                    novatosValor: e.valor_bonus,
                    novatosDetalhes: e.detalhes || ""
                }),
                className: "text-xs text-blue-500 hover:text-blue-700",
                title: "Editar"
            }, "✏️"), React.createElement("button", {
                onClick: async () => {
                    await fetch(`${API_URL}/promocoes-novatos/${e.id}`, {
                        method: "PATCH",
                        headers: {
                            "Content-Type": "application/json"
                        },
                        body: JSON.stringify({
                            status: "ativa" === e.status ? "inativa" : "ativa"
                        })
                    }), Cl()
                },
                className: "text-xs text-gray-500 hover:text-gray-700",
                title: "ativa" === e.status ? "Desativar" : "Ativar"
            }, "ativa" === e.status ? "⏸️" : "▶️"), React.createElement("button", {
                onClick: () => (async e => {
                    if (confirm("Tem certeza que deseja excluir esta promoção?")) {
                        s(!0);
                        try {
                            const t = await fetch(`${API_URL}/promocoes-novatos/${e}`, {
                                method: "DELETE"
                            });
                            if (!t.ok) {
                                const e = await t.json();
                                throw new Error(e.error || "Erro ao excluir")
                            }
                            ja("🗑️ Promoção excluída!", "success"), await Cl()
                        } catch (e) {
                            ja(e.message, "error")
                        } finally {
                            s(!1)
                        }
                    }
                })(e.id),
                className: "text-xs text-red-500 hover:text-red-700",
                title: "Excluir"
            }, "🗑️"))), React.createElement("p", {
                className: "font-semibold text-sm"
            }, "📍 ", e.regiao), React.createElement("p", {
                className: "text-sm text-gray-700"
            }, "🏢 ", e.cliente), React.createElement("p", {
                className: "text-lg font-bold text-green-600"
            }, er(e.valor_bonus)), e.detalhes && React.createElement("p", {
                className: "text-xs text-gray-600 mt-1 whitespace-pre-wrap line-clamp-2",
                title: e.detalhes
            }, e.detalhes))))), React.createElement("div", {
                className: "grid grid-cols-2 md:grid-cols-4 gap-4 mb-6"
            }, React.createElement("div", {
                className: "bg-yellow-50 border border-yellow-200 rounded-xl p-4 text-center"
            }, React.createElement("p", {
                className: "text-3xl font-bold text-yellow-600"
            }, ne.filter(e => "pendente" === e.status).length), React.createElement("p", {
                className: "text-sm text-yellow-700"
            }, "Pendentes")), React.createElement("div", {
                className: "bg-green-50 border border-green-200 rounded-xl p-4 text-center"
            }, React.createElement("p", {
                className: "text-3xl font-bold text-green-600"
            }, ne.filter(e => "aprovada" === e.status).length), React.createElement("p", {
                className: "text-sm text-green-700"
            }, "Aprovadas")), React.createElement("div", {
                className: "bg-red-50 border border-red-200 rounded-xl p-4 text-center"
            }, React.createElement("p", {
                className: "text-3xl font-bold text-red-600"
            }, ne.filter(e => "rejeitada" === e.status).length), React.createElement("p", {
                className: "text-sm text-red-700"
            }, "Rejeitadas")), React.createElement("div", {
                className: "bg-gray-50 border border-gray-200 rounded-xl p-4 text-center"
            }, React.createElement("p", {
                className: "text-3xl font-bold text-gray-600"
            }, ne.filter(e => "expirada" === e.status).length), React.createElement("p", {
                className: "text-sm text-gray-700"
            }, "Expiradas"))), React.createElement("div", {
                className: "bg-white rounded-xl shadow p-6"
            }, React.createElement("h3", {
                className: "font-semibold mb-4"
            }, "🚀 Inscrições de Novatos"), 0 === ne.length ? React.createElement("p", {
                className: "text-gray-500 text-center py-8"
            }, "Nenhuma inscrição recebida") : React.createElement("div", {
                className: "overflow-x-auto"
            }, React.createElement("table", {
                className: "w-full text-sm"
            }, React.createElement("thead", {
                className: "bg-gray-50"
            }, React.createElement("tr", null, React.createElement("th", {
                className: "px-2 py-3 text-left text-xs"
            }, "Data"), React.createElement("th", {
                className: "px-2 py-3 text-left text-xs"
            }, "Profissional"), React.createElement("th", {
                className: "px-2 py-3 text-left text-xs"
            }, "COD"), React.createElement("th", {
                className: "px-2 py-3 text-left text-xs"
            }, "Região"), React.createElement("th", {
                className: "px-2 py-3 text-left text-xs"
            }, "Cliente"), React.createElement("th", {
                className: "px-2 py-3 text-center text-xs"
            }, "Bônus"), React.createElement("th", {
                className: "px-2 py-3 text-center text-xs"
            }, "Expira"), React.createElement("th", {
                className: "px-2 py-3 text-center text-xs"
            }, "Crédito"), React.createElement("th", {
                className: "px-3 py-3 text-center"
            }, "Status"), React.createElement("th", {
                className: "px-2 py-3 text-center text-xs"
            }, "Admin"), React.createElement("th", {
                className: "px-2 py-3 text-center text-xs"
            }, "Ações"))), React.createElement("tbody", null, ne.map(e => {
                const t = e.expires_at ? new Date(e.expires_at) : null,
                    a = t && new Date > t;
                return React.createElement("tr", {
                    key: e.id,
                    className: "border-b " + ("aprovada" === e.status ? "bg-green-50" : "rejeitada" === e.status ? "bg-red-50" : a && "pendente" === e.status ? "bg-gray-100" : "")
                }, React.createElement("td", {
                    className: "px-2 py-3 text-xs"
                }, new Date(e.created_at).toLocaleDateString("pt-BR")), React.createElement("td", {
                    className: "px-2 py-3 text-xs font-medium"
                }, e.user_name), React.createElement("td", {
                    className: "px-2 py-3 text-xs"
                }, e.user_cod), React.createElement("td", {
                    className: "px-2 py-3 text-xs"
                }, e.regiao), React.createElement("td", {
                    className: "px-2 py-3 text-xs"
                }, e.cliente), React.createElement("td", {
                    className: "px-2 py-3 text-center text-xs font-bold text-green-600"
                }, er(e.valor_bonus)), React.createElement("td", {
                    className: "px-2 py-3 text-center text-xs"
                }, t ? React.createElement("span", {
                    className: a ? "text-red-500" : "text-gray-600"
                }, t.toLocaleDateString("pt-BR")) : "-"), React.createElement("td", {
                    className: "px-2 py-3 text-center"
                }, "aprovada" === e.status ? e.credito_lancado ? React.createElement("div", null, React.createElement("span", {
                    className: "text-xs text-green-600 font-bold"
                }, "✅ Lançado"), e.lancado_por && React.createElement("p", {
                    className: "text-xs text-gray-400"
                }, e.lancado_por)) : React.createElement("button", {
                    onClick: () => (async e => {
                        s(!0);
                        try {
                            if (!(await fetch(`${API_URL}/inscricoes-novatos/${e.id}/credito`, {
                                    method: "PATCH",
                                    headers: {
                                        "Content-Type": "application/json"
                                    },
                                    body: JSON.stringify({
                                        credito_lancado: !0,
                                        lancado_por: l.fullName
                                    })
                                })).ok) throw new Error("Erro ao creditar");
                            ja("✅ Crédito lançado!", "success"), await Sl()
                        } catch (e) {
                            ja("Erro ao creditar", "error")
                        } finally {
                            s(!1)
                        }
                    })(e),
                    className: "px-2 py-1 bg-blue-500 text-white text-xs rounded hover:bg-blue-600",
                    disabled: c
                }, "💰 Lançar") : "-"), React.createElement("td", {
                    className: "px-3 py-3 text-center"
                }, React.createElement("span", {
                    className: "px-2 py-1 rounded-full text-xs font-bold " + ("pendente" === e.status ? a ? "bg-gray-200 text-gray-700" : "bg-yellow-100 text-yellow-700" : "aprovada" === e.status ? "bg-green-100 text-green-700" : "rejeitada" === e.status ? "bg-red-100 text-red-700" : "bg-gray-100 text-gray-700")
                }, "pendente" === e.status && a ? "⏰ Expirada" : "pendente" === e.status ? "⏳ Pendente" : "aprovada" === e.status ? "✅ Aprovada" : "rejeitada" === e.status ? "❌ Rejeitada" : e.status)), React.createElement("td", {
                    className: "px-2 py-3 text-center text-xs text-gray-500"
                }, e.resolved_by || "-"), React.createElement("td", {
                    className: "px-2 py-3 text-center"
                }, "pendente" === e.status && !a && React.createElement("div", {
                    className: "flex gap-1 justify-center"
                }, React.createElement("button", {
                    onClick: () => (async e => {
                        s(!0);
                        try {
                            await fetch(`${API_URL}/inscricoes-novatos/${e}/aprovar`, {
                                method: "PATCH",
                                headers: {
                                    "Content-Type": "application/json"
                                },
                                body: JSON.stringify({
                                    resolved_by: l.fullName
                                })
                            }), ja("✅ Inscrição aprovada!", "success"), await Sl()
                        } catch (e) {
                            ja("Erro ao aprovar", "error")
                        } finally {
                            s(!1)
                        }
                    })(e.id),
                    className: "p-1 bg-green-500 text-white rounded text-xs hover:bg-green-600",
                    disabled: c
                }, "✓"), React.createElement("button", {
                    onClick: () => x({
                        ...p,
                        modalRejeitarNovatos: e
                    }),
                    className: "p-1 bg-red-500 text-white rounded text-xs hover:bg-red-600"
                }, "✗")), "rejeitada" === e.status && e.motivo_rejeicao && React.createElement("span", {
                    className: "text-xs text-red-500",
                    title: e.motivo_rejeicao
                }, "📝")))
            })))))), "loja" === p.finTab && React.createElement(React.Fragment, null, React.createElement("div", {
                className: "bg-white rounded-xl shadow mb-6"
            }, React.createElement("div", {
                className: "flex border-b"
            }, ["produtos", "estoque", "pedidos", "sugestoes"].map(e => React.createElement("button", {
                key: e,
                onClick: () => {
                    mt(e), "estoque" === e && Ja(), "produtos" === e && (Ha(), Ja()), "pedidos" === e && Wa(), "sugestoes" === e && Ya()
                },
                className: "flex-1 px-4 py-3 text-sm font-semibold relative " + (nt === e ? "text-purple-700 border-b-2 border-purple-600 bg-purple-50" : "text-gray-600 hover:bg-gray-50")
            }, "produtos" === e && "🏷️ Produtos", "estoque" === e && "📦 Estoque", "pedidos" === e && "🛍️ Pedidos", "sugestoes" === e && React.createElement(React.Fragment, null, "💡 Sugestões", ut.filter(e => "pendente" === e.status).length > 0 && React.createElement("span", {
                className: "absolute -top-1 -right-1 bg-orange-500 text-white text-xs font-bold rounded-full w-5 h-5 flex items-center justify-center"
            }, ut.filter(e => "pendente" === e.status).length))))), React.createElement("div", {
                className: "p-6"
            }, "estoque" === nt && React.createElement(React.Fragment, null, React.createElement("div", {
                className: "flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-6"
            }, React.createElement("div", null, React.createElement("h2", {
                className: "text-xl font-bold text-gray-800"
            }, "📦 Controle de Estoque"), React.createElement("p", {
                className: "text-sm text-gray-500"
            }, "Gerencie produtos, entradas e saídas")), React.createElement("div", {
                className: "flex gap-2"
            }, React.createElement("div", {
                className: "flex bg-gray-100 rounded-lg p-1"
            }, React.createElement("button", {
                onClick: () => {
                    xt("lista")
                },
                className: "px-3 py-1.5 rounded-lg text-sm font-semibold transition-all " + ("lista" === pt ? "bg-white shadow text-purple-700" : "text-gray-600 hover:text-gray-800")
            }, "📋 Produtos"), React.createElement("button", {
                onClick: () => {
                    xt("movimentacoes"), Qa()
                },
                className: "px-3 py-1.5 rounded-lg text-sm font-semibold transition-all " + ("movimentacoes" === pt ? "bg-white shadow text-purple-700" : "text-gray-600 hover:text-gray-800")
            }, "📊 Histórico")), React.createElement("button", {
                onClick: () => x({
                    ...p,
                    lojaEstoqueModal: !0,
                    lojaEstoqueEdit: null
                }),
                className: "px-4 py-2 bg-purple-600 text-white rounded-lg font-semibold hover:bg-purple-700"
            }, "➕ Novo Item"))), React.createElement("div", {
                className: "grid grid-cols-2 md:grid-cols-4 gap-4 mb-6"
            }, React.createElement("div", {
                className: "bg-white rounded-xl shadow p-4"
            }, React.createElement("p", {
                className: "text-sm text-gray-600"
            }, "Total de Itens"), React.createElement("p", {
                className: "text-2xl font-bold text-purple-600"
            }, Ze.length)), React.createElement("div", {
                className: "bg-white rounded-xl shadow p-4"
            }, React.createElement("p", {
                className: "text-sm text-gray-600"
            }, "Itens Ativos"), React.createElement("p", {
                className: "text-2xl font-bold text-green-600"
            }, Ze.filter(e => "ativo" === e.status).length)), React.createElement("div", {
                className: "bg-white rounded-xl shadow p-4"
            }, React.createElement("p", {
                className: "text-sm text-gray-600"
            }, "Qtd. Total em Estoque"), React.createElement("p", {
                className: "text-2xl font-bold text-blue-600"
            }, Ze.reduce((e, t) => t.tem_tamanho && t.tamanhos ? e + t.tamanhos.reduce((e, t) => e + (t.quantidade || 0), 0) : e + (t.quantidade || 0), 0))), React.createElement("div", {
                className: "bg-white rounded-xl shadow p-4"
            }, React.createElement("p", {
                className: "text-sm text-gray-600"
            }, "Valor Total"), React.createElement("p", {
                className: "text-2xl font-bold text-green-600"
            }, "R$ ", Ze.reduce((e, t) => {
                const a = t.tem_tamanho && t.tamanhos ? t.tamanhos.reduce((e, t) => e + (t.quantidade || 0), 0) : t.quantidade || 0;
                return e + parseFloat(t.valor) * a
            }, 0).toFixed(2).replace(".", ",")))), "lista" === pt && React.createElement("div", {
                className: "grid gap-4"
            }, 0 === Ze.length ? React.createElement("p", {
                className: "text-gray-500 text-center py-8"
            }, "Nenhum item no estoque") : Ze.map(e => {
                const t = e.tem_tamanho && e.tamanhos ? e.tamanhos.reduce((e, t) => e + (t.quantidade || 0), 0) : e.quantidade || 0,
                    a = t > 0 && t <= 3,
                    l = 0 === t;
                return React.createElement("div", {
                    key: e.id,
                    className: "border-2 rounded-xl p-4 hover:shadow-md transition-shadow " + (l ? "border-red-200 bg-red-50" : a ? "border-yellow-200 bg-yellow-50" : "border-gray-200")
                }, React.createElement("div", {
                    className: "flex gap-4"
                }, e.imagem_url && React.createElement("img", {
                    src: e.imagem_url,
                    alt: e.nome,
                    className: "w-24 h-24 object-contain rounded-lg bg-gray-100"
                }), React.createElement("div", {
                    className: "flex-1"
                }, React.createElement("div", {
                    className: "flex justify-between items-start"
                }, React.createElement("div", null, React.createElement("h3", {
                    className: "font-bold text-gray-800 text-lg"
                }, e.nome), e.marca && React.createElement("p", {
                    className: "text-sm text-gray-600"
                }, "Marca: ", e.marca), React.createElement("p", {
                    className: "text-lg font-bold text-green-600"
                }, "R$ ", parseFloat(e.valor).toFixed(2).replace(".", ","))), React.createElement("div", {
                    className: "flex flex-col items-end gap-1"
                }, React.createElement("span", {
                    className: "px-3 py-1 rounded-full text-xs font-bold " + ("ativo" === e.status ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700")
                }, "ativo" === e.status ? "✅ Ativo" : "❌ Inativo"), l && React.createElement("span", {
                    className: "px-2 py-0.5 bg-red-500 text-white text-xs rounded-full"
                }, "SEM ESTOQUE"), a && !l && React.createElement("span", {
                    className: "px-2 py-0.5 bg-yellow-500 text-white text-xs rounded-full"
                }, "ESTOQUE BAIXO"))), e.tem_tamanho && e.tamanhos && e.tamanhos.length > 0 ? React.createElement("div", {
                    className: "mt-3"
                }, React.createElement("p", {
                    className: "text-xs text-gray-500 mb-1"
                }, "Tamanhos em estoque:"), React.createElement("div", {
                    className: "flex flex-wrap gap-2"
                }, e.tamanhos.map(e => React.createElement("span", {
                    key: e.id,
                    className: "px-3 py-1 rounded-lg text-sm font-semibold " + (e.quantidade <= 0 ? "bg-red-100 text-red-700" : e.quantidade <= 3 ? "bg-yellow-100 text-yellow-700" : "bg-green-100 text-green-700")
                }, e.tamanho, ": ", React.createElement("strong", null, e.quantidade))))) : React.createElement("div", {
                    className: "mt-3 flex items-center gap-2"
                }, React.createElement("span", {
                    className: "text-sm text-gray-600"
                }, "Quantidade:"), React.createElement("span", {
                    className: "px-3 py-1 rounded-lg text-lg font-bold " + (e.quantidade <= 0 ? "bg-red-100 text-red-700" : e.quantidade <= 3 ? "bg-yellow-100 text-yellow-700" : "bg-green-100 text-green-700")
                }, e.quantidade))), React.createElement("div", {
                    className: "flex flex-col gap-2"
                }, React.createElement("button", {
                    onClick: () => x({
                        ...p,
                        lojaMovModal: !0,
                        lojaMovItem: e,
                        lojaMovTipo: "entrada"
                    }),
                    className: "px-3 py-1.5 bg-green-100 text-green-700 rounded-lg text-xs font-semibold hover:bg-green-200 flex items-center gap-1"
                }, "📥 Entrada"), React.createElement("button", {
                    onClick: () => x({
                        ...p,
                        lojaMovModal: !0,
                        lojaMovItem: e,
                        lojaMovTipo: "saida"
                    }),
                    className: "px-3 py-1.5 bg-red-100 text-red-700 rounded-lg text-xs font-semibold hover:bg-red-200 flex items-center gap-1"
                }, "📤 Saída"), React.createElement("button", {
                    onClick: () => x({
                        ...p,
                        lojaEstoqueModal: !0,
                        lojaEstoqueEdit: e
                    }),
                    className: "px-3 py-1.5 bg-blue-100 text-blue-700 rounded-lg text-xs font-semibold hover:bg-blue-200"
                }, "✏️ Editar"), React.createElement("button", {
                    onClick: async () => {
                        confirm("Excluir este item do estoque?") && (await fetch(`${API_URL}/loja/estoque/${e.id}`, {
                            method: "DELETE"
                        }), Ja(), ja("🗑️ Item excluído!", "success"))
                    },
                    className: "px-3 py-1.5 bg-gray-100 text-gray-700 rounded-lg text-xs font-semibold hover:bg-gray-200"
                }, "🗑️"))))
            })), "movimentacoes" === pt && React.createElement("div", {
                className: "bg-white rounded-xl shadow"
            }, React.createElement("div", {
                className: "p-4 border-b"
            }, React.createElement("h3", {
                className: "font-bold text-gray-800"
            }, "📊 Histórico de Movimentações"), React.createElement("p", {
                className: "text-sm text-gray-500"
            }, "Todas as entradas e saídas do estoque")), React.createElement("div", {
                className: "overflow-x-auto"
            }, React.createElement("table", {
                className: "w-full text-sm"
            }, React.createElement("thead", {
                className: "bg-gray-50"
            }, React.createElement("tr", null, React.createElement("th", {
                className: "px-4 py-3 text-left"
            }, "Data/Hora"), React.createElement("th", {
                className: "px-4 py-3 text-left"
            }, "Produto"), React.createElement("th", {
                className: "px-4 py-3 text-center"
            }, "Tipo"), React.createElement("th", {
                className: "px-4 py-3 text-center"
            }, "Tam."), React.createElement("th", {
                className: "px-4 py-3 text-center"
            }, "Qtd."), React.createElement("th", {
                className: "px-4 py-3 text-left"
            }, "Motivo"), React.createElement("th", {
                className: "px-4 py-3 text-left"
            }, "Por"))), React.createElement("tbody", null, 0 === it.length ? React.createElement("tr", null, React.createElement("td", {
                colSpan: "7",
                className: "text-center py-8 text-gray-500"
            }, "Nenhuma movimentação registrada")) : it.map(e => React.createElement("tr", {
                key: e.id,
                className: "border-t hover:bg-gray-50"
            }, React.createElement("td", {
                className: "px-4 py-3 text-xs"
            }, new Date(e.created_at).toLocaleDateString("pt-BR"), React.createElement("br", null), React.createElement("span", {
                className: "text-gray-500"
            }, new Date(e.created_at).toLocaleTimeString("pt-BR", {
                hour: "2-digit",
                minute: "2-digit"
            }))), React.createElement("td", {
                className: "px-4 py-3"
            }, React.createElement("p", {
                className: "font-semibold"
            }, e.produto_nome), e.marca && React.createElement("p", {
                className: "text-xs text-gray-500"
            }, e.marca)), React.createElement("td", {
                className: "px-4 py-3 text-center"
            }, React.createElement("span", {
                className: "px-2 py-1 rounded-full text-xs font-bold " + ("entrada" === e.tipo ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700")
            }, "entrada" === e.tipo ? "📥 Entrada" : "📤 Saída")), React.createElement("td", {
                className: "px-4 py-3 text-center font-semibold"
            }, e.tamanho || "-"), React.createElement("td", {
                className: "px-4 py-3 text-center"
            }, React.createElement("span", {
                className: "text-lg font-bold " + ("entrada" === e.tipo ? "text-green-600" : "text-red-600")
            }, "entrada" === e.tipo ? "+" : "-", e.quantidade)), React.createElement("td", {
                className: "px-4 py-3 text-sm text-gray-600"
            }, e.motivo || "-"), React.createElement("td", {
                className: "px-4 py-3 text-sm"
            }, e.created_by || "-"))))))), p.lojaEstoqueModal && React.createElement("div", {
                className: "fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4"
            }, React.createElement("div", {
                className: "bg-white rounded-2xl shadow-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto"
            }, React.createElement("div", {
                className: "p-6"
            }, React.createElement("h2", {
                className: "text-xl font-bold mb-4"
            }, p.lojaEstoqueEdit ? "✏️ Editar Item" : "➕ Novo Item no Estoque"), React.createElement("div", {
                className: "space-y-4"
            }, React.createElement("div", null, React.createElement("label", {
                className: "block text-sm font-semibold mb-1"
            }, "Nome do Produto *"), React.createElement("input", {
                type: "text",
                value: p.lojaEstoqueNome ?? p.lojaEstoqueEdit?.nome ?? "",
                onChange: e => x({
                    ...p,
                    lojaEstoqueNome: e.target.value
                }),
                className: "w-full px-4 py-2 border rounded-lg",
                placeholder: "Ex: Camiseta Polo"
            })), React.createElement("div", {
                className: "grid grid-cols-2 gap-4"
            }, React.createElement("div", null, React.createElement("label", {
                className: "block text-sm font-semibold mb-1"
            }, "Marca"), React.createElement("input", {
                type: "text",
                value: p.lojaEstoqueMarca ?? p.lojaEstoqueEdit?.marca ?? "",
                onChange: e => x({
                    ...p,
                    lojaEstoqueMarca: e.target.value
                }),
                className: "w-full px-4 py-2 border rounded-lg",
                placeholder: "Ex: Nike"
            })), React.createElement("div", null, React.createElement("label", {
                className: "block text-sm font-semibold mb-1"
            }, "Valor (R$) *"), React.createElement("input", {
                type: "number",
                step: "0.01",
                value: p.lojaEstoqueValor ?? p.lojaEstoqueEdit?.valor ?? "",
                onChange: e => x({
                    ...p,
                    lojaEstoqueValor: e.target.value
                }),
                className: "w-full px-4 py-2 border rounded-lg",
                placeholder: "99.90"
            }))), React.createElement("div", null, React.createElement("label", {
                className: "block text-sm font-semibold mb-1"
            }, "Imagem do Produto"), React.createElement("div", {
                className: "space-y-2"
            }, (p.lojaEstoqueImagem || p.lojaEstoqueEdit?.imagem_url) && React.createElement("div", {
                className: "relative inline-block"
            }, React.createElement("img", {
                src: p.lojaEstoqueImagem || p.lojaEstoqueEdit?.imagem_url,
                alt: "Preview",
                className: "w-20 h-20 object-cover rounded-lg border"
            }), React.createElement("button", {
                type: "button",
                onClick: () => x({
                    ...p,
                    lojaEstoqueImagem: ""
                }),
                className: "absolute -top-2 -right-2 w-6 h-6 bg-red-500 text-white rounded-full text-xs hover:bg-red-600"
            }, "✕")), React.createElement("label", {
                className: "block cursor-pointer"
            }, React.createElement("div", {
                className: "px-4 py-2 bg-purple-100 text-purple-700 rounded-lg text-center font-semibold hover:bg-purple-200 transition-colors text-sm"
            }, p.uploadingEstoqueImage ? "⏳ Enviando..." : "📷 Fazer Upload"), React.createElement("input", {
                type: "file",
                accept: "image/*",
                className: "hidden",
                disabled: p.uploadingEstoqueImage,
                onChange: async e => {
                    const t = e.target.files?.[0];
                    if (t)
                        if (t.size > 2097152) ja("Imagem muito grande (máx 2MB)", "error");
                        else {
                            x({
                                ...p,
                                uploadingEstoqueImage: !0
                            });
                            try {
                                const e = new FileReader;
                                e.onload = e => {
                                    const t = e.target.result;
                                    x({
                                        ...p,
                                        lojaEstoqueImagem: t,
                                        uploadingEstoqueImage: !1
                                    }), ja("✅ Imagem carregada!", "success")
                                }, e.onerror = () => {
                                    throw new Error("Erro ao ler arquivo")
                                }, e.readAsDataURL(t)
                            } catch (e) {
                                console.error("Erro upload:", e), ja("Erro ao carregar imagem", "error"), x({
                                    ...p,
                                    uploadingEstoqueImage: !1
                                })
                            }
                        }
                }
            })), React.createElement("details", {
                className: "text-xs"
            }, React.createElement("summary", {
                className: "cursor-pointer text-gray-500"
            }, "Ou cole uma URL"), React.createElement("input", {
                type: "text",
                placeholder: "https://...",
                value: p.lojaEstoqueImagem ?? p.lojaEstoqueEdit?.imagem_url ?? "",
                onChange: e => x({
                    ...p,
                    lojaEstoqueImagem: e.target.value
                }),
                className: "w-full px-3 py-1 border rounded mt-1 text-sm"
            })))), React.createElement("div", {
                className: "flex items-center gap-2"
            }, React.createElement("input", {
                type: "checkbox",
                id: "temTamanho",
                checked: p.lojaEstoqueTemTamanho ?? p.lojaEstoqueEdit?.tem_tamanho ?? !1,
                onChange: e => x({
                    ...p,
                    lojaEstoqueTemTamanho: e.target.checked
                }),
                className: "w-5 h-5"
            }), React.createElement("label", {
                htmlFor: "temTamanho",
                className: "text-sm font-semibold"
            }, "Este produto tem tamanhos")), (p.lojaEstoqueTemTamanho ?? p.lojaEstoqueEdit?.tem_tamanho) && React.createElement("div", null, React.createElement("div", {
                className: "flex gap-2 mb-3"
            }, React.createElement("button", {
                type: "button",
                onClick: () => x({
                    ...p,
                    lojaEstoqueTipoTamanho: "letras"
                }),
                className: "flex-1 px-3 py-2 rounded-lg text-sm font-semibold border-2 " + ("letras" === (p.lojaEstoqueTipoTamanho ?? p.lojaEstoqueEdit?.tipo_tamanho ?? "letras") ? "border-purple-500 bg-purple-50 text-purple-700" : "border-gray-200 text-gray-600")
            }, "PP, P, M, G..."), React.createElement("button", {
                type: "button",
                onClick: () => x({
                    ...p,
                    lojaEstoqueTipoTamanho: "numeros"
                }),
                className: "flex-1 px-3 py-2 rounded-lg text-sm font-semibold border-2 " + ("numeros" === (p.lojaEstoqueTipoTamanho ?? p.lojaEstoqueEdit?.tipo_tamanho) ? "border-purple-500 bg-purple-50 text-purple-700" : "border-gray-200 text-gray-600")
            }, "Numeração (34, 36...)")), "letras" === (p.lojaEstoqueTipoTamanho ?? p.lojaEstoqueEdit?.tipo_tamanho ?? "letras") ? React.createElement(React.Fragment, null, React.createElement("label", {
                className: "block text-sm font-semibold mb-2"
            }, "Tamanhos e Quantidades"), React.createElement("div", {
                className: "grid grid-cols-2 gap-2"
            }, ["PP", "P", "M", "G", "GG", "XG", "XXG"].map(e => {
                const t = (p.lojaEstoqueEdit?.tamanhos || []).find(t => t.tamanho === e);
                return React.createElement("div", {
                    key: e,
                    className: "flex items-center gap-2 bg-gray-50 p-2 rounded"
                }, React.createElement("span", {
                    className: "w-10 text-sm font-bold text-purple-700"
                }, e), React.createElement("input", {
                    type: "number",
                    min: "0",
                    value: p[`lojaEstoqueTam_${e}`] ?? t?.quantidade ?? 0,
                    onChange: t => x({
                        ...p,
                        [`lojaEstoqueTam_${e}`]: parseInt(t.target.value) || 0
                    }),
                    className: "flex-1 px-2 py-1 border rounded text-center",
                    placeholder: "0"
                }))
            }))) : React.createElement(React.Fragment, null, React.createElement("label", {
                className: "block text-sm font-semibold mb-2"
            }, "Numerações e Quantidades"), React.createElement("div", {
                className: "space-y-2"
            }, (p.lojaEstoqueNumeracoes ?? p.lojaEstoqueEdit?.tamanhos?.map(e => ({
                num: e.tamanho,
                qtd: e.quantidade
            })) ?? [{
                num: "",
                qtd: 0
            }]).map((e, t) => React.createElement("div", {
                key: t,
                className: "flex items-center gap-2"
            }, React.createElement("input", {
                type: "text",
                placeholder: "Ex: 38",
                value: e.num,
                onChange: e => {
                    const a = [...p.lojaEstoqueNumeracoes ?? p.lojaEstoqueEdit?.tamanhos?.map(e => ({
                        num: e.tamanho,
                        qtd: e.quantidade
                    })) ?? [{
                        num: "",
                        qtd: 0
                    }]];
                    a[t].num = e.target.value, x({
                        ...p,
                        lojaEstoqueNumeracoes: a
                    })
                },
                className: "w-20 px-2 py-1 border rounded text-center font-bold"
            }), React.createElement("input", {
                type: "number",
                min: "0",
                placeholder: "Qtd",
                value: e.qtd,
                onChange: e => {
                    const a = [...p.lojaEstoqueNumeracoes ?? p.lojaEstoqueEdit?.tamanhos?.map(e => ({
                        num: e.tamanho,
                        qtd: e.quantidade
                    })) ?? [{
                        num: "",
                        qtd: 0
                    }]];
                    a[t].qtd = parseInt(e.target.value) || 0, x({
                        ...p,
                        lojaEstoqueNumeracoes: a
                    })
                },
                className: "w-20 px-2 py-1 border rounded text-center"
            }), React.createElement("button", {
                type: "button",
                onClick: () => {
                    const e = [...p.lojaEstoqueNumeracoes ?? p.lojaEstoqueEdit?.tamanhos?.map(e => ({
                        num: e.tamanho,
                        qtd: e.quantidade
                    })) ?? [{
                        num: "",
                        qtd: 0
                    }]];
                    e.splice(t, 1), x({
                        ...p,
                        lojaEstoqueNumeracoes: e.length ? e : [{
                            num: "",
                            qtd: 0
                        }]
                    })
                },
                className: "px-2 py-1 bg-red-100 text-red-600 rounded hover:bg-red-200"
            }, "🗑️"))), React.createElement("button", {
                type: "button",
                onClick: () => {
                    const e = [...p.lojaEstoqueNumeracoes ?? p.lojaEstoqueEdit?.tamanhos?.map(e => ({
                        num: e.tamanho,
                        qtd: e.quantidade
                    })) ?? [{
                        num: "",
                        qtd: 0
                    }]];
                    e.push({
                        num: "",
                        qtd: 0
                    }), x({
                        ...p,
                        lojaEstoqueNumeracoes: e
                    })
                },
                className: "w-full px-3 py-2 bg-purple-100 text-purple-700 rounded-lg text-sm font-semibold hover:bg-purple-200"
            }, "➕ Adicionar Numeração")))), !(p.lojaEstoqueTemTamanho ?? p.lojaEstoqueEdit?.tem_tamanho) && React.createElement("div", null, React.createElement("label", {
                className: "block text-sm font-semibold mb-1"
            }, "Quantidade em Estoque *"), React.createElement("input", {
                type: "number",
                min: "0",
                value: p.lojaEstoqueQtd ?? p.lojaEstoqueEdit?.quantidade ?? 0,
                onChange: e => x({
                    ...p,
                    lojaEstoqueQtd: parseInt(e.target.value) || 0
                }),
                className: "w-full px-4 py-2 border rounded-lg"
            }))), React.createElement("div", {
                className: "flex gap-3 mt-6"
            }, React.createElement("button", {
                onClick: () => x({
                    ...p,
                    lojaEstoqueModal: !1,
                    lojaEstoqueEdit: null,
                    lojaEstoqueNome: "",
                    lojaEstoqueMarca: "",
                    lojaEstoqueValor: "",
                    lojaEstoqueImagem: "",
                    lojaEstoqueTemTamanho: !1,
                    lojaEstoqueQtd: 0,
                    lojaEstoqueTipoTamanho: null,
                    lojaEstoqueNumeracoes: null
                }),
                className: "flex-1 px-4 py-2 bg-gray-200 text-gray-700 rounded-lg font-semibold"
            }, "Cancelar"), React.createElement("button", {
                onClick: async () => {
                    const e = p.lojaEstoqueNome ?? p.lojaEstoqueEdit?.nome,
                        t = p.lojaEstoqueValor ?? p.lojaEstoqueEdit?.valor;
                    if (!e || !t) return void ja("Preencha nome e valor", "error");
                    const a = p.lojaEstoqueTemTamanho ?? p.lojaEstoqueEdit?.tem_tamanho,
                        r = p.lojaEstoqueTipoTamanho ?? p.lojaEstoqueEdit?.tipo_tamanho ?? "letras";
                    let o = [];
                    if (a)
                        if ("letras" === r)["PP", "P", "M", "G", "GG", "XG", "XXG"].forEach(e => {
                            const t = p[`lojaEstoqueTam_${e}`] ?? (p.lojaEstoqueEdit?.tamanhos || []).find(t => t.tamanho === e)?.quantidade ?? 0;
                            t > 0 && o.push({
                                tamanho: e,
                                quantidade: t
                            })
                        });
                        else {
                            (p.lojaEstoqueNumeracoes ?? p.lojaEstoqueEdit?.tamanhos?.map(e => ({
                                num: e.tamanho,
                                qtd: e.quantidade
                            })) ?? []).forEach(e => {
                                e.num && e.qtd > 0 && o.push({
                                    tamanho: e.num,
                                    quantidade: e.qtd
                                })
                            })
                        } const c = {
                        nome: e,
                        marca: p.lojaEstoqueMarca ?? p.lojaEstoqueEdit?.marca ?? "",
                        valor: parseFloat(t),
                        quantidade: a ? 0 : p.lojaEstoqueQtd ?? p.lojaEstoqueEdit?.quantidade ?? 0,
                        tem_tamanho: a,
                        tipo_tamanho: r,
                        tamanhos: o,
                        imagem_url: p.lojaEstoqueImagem ?? p.lojaEstoqueEdit?.imagem_url ?? "",
                        created_by: l.fullName
                    };
                    if (!!p.lojaEstoqueEdit) await fetch(`${API_URL}/loja/estoque/${p.lojaEstoqueEdit.id}`, {
                        method: "PUT",
                        headers: {
                            "Content-Type": "application/json"
                        },
                        body: JSON.stringify(c)
                    }), ja("✅ Item atualizado!", "success");
                    else {
                        const e = await fetch(`${API_URL}/loja/estoque`, {
                                method: "POST",
                                headers: {
                                    "Content-Type": "application/json"
                                },
                                body: JSON.stringify(c)
                            }),
                            t = await e.json(),
                            r = a ? o.reduce((e, t) => e + t.quantidade, 0) : c.quantidade || 0;
                        r > 0 && await fetch(`${API_URL}/loja/estoque/${t.id}/entrada`, {
                            method: "POST",
                            headers: {
                                "Content-Type": "application/json"
                            },
                            body: JSON.stringify({
                                quantidade: r,
                                motivo: "Estoque inicial",
                                created_by: l.fullName
                            })
                        }), ja("✅ Item adicionado!", "success")
                    }
                    x({
                        ...p,
                        lojaEstoqueModal: !1,
                        lojaEstoqueEdit: null,
                        lojaEstoqueNome: "",
                        lojaEstoqueMarca: "",
                        lojaEstoqueValor: "",
                        lojaEstoqueImagem: "",
                        lojaEstoqueTemTamanho: !1,
                        lojaEstoqueQtd: 0
                    }), Ja(), Qa()
                },
                className: "flex-1 px-4 py-2 bg-purple-600 text-white rounded-lg font-semibold hover:bg-purple-700"
            }, p.lojaEstoqueEdit ? "💾 Salvar" : "➕ Adicionar"))))), p.lojaMovModal && React.createElement("div", {
                className: "fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4"
            }, React.createElement("div", {
                className: "bg-white rounded-2xl shadow-2xl max-w-md w-full"
            }, React.createElement("div", {
                className: `p-4 rounded-t-2xl ${"entrada"===p.lojaMovTipo?"bg-green-600":"bg-red-600"} text-white`
            }, React.createElement("h2", {
                className: "text-xl font-bold"
            }, "entrada" === p.lojaMovTipo ? "📥 Registrar Entrada" : "📤 Registrar Saída"), React.createElement("p", {
                className: "text-sm opacity-80"
            }, p.lojaMovItem?.nome)), React.createElement("div", {
                className: "p-6 space-y-4"
            }, p.lojaMovItem?.tem_tamanho && p.lojaMovItem?.tamanhos?.length > 0 && React.createElement("div", null, React.createElement("label", {
                className: "block text-sm font-semibold mb-2"
            }, "Tamanho"), React.createElement("select", {
                value: p.lojaMovTamanho || "",
                onChange: e => x({
                    ...p,
                    lojaMovTamanho: e.target.value
                }),
                className: "w-full px-4 py-2 border rounded-lg"
            }, React.createElement("option", {
                value: ""
            }, "Selecione o tamanho"), p.lojaMovItem.tamanhos.map(e => React.createElement("option", {
                key: e.tamanho,
                value: e.tamanho
            }, e.tamanho, " (atual: ", e.quantidade, ")")))), React.createElement("div", null, React.createElement("label", {
                className: "block text-sm font-semibold mb-2"
            }, "Quantidade *"), React.createElement("input", {
                type: "number",
                min: "1",
                value: p.lojaMovQtd || "",
                onChange: e => x({
                    ...p,
                    lojaMovQtd: parseInt(e.target.value) || 0
                }),
                className: "w-full px-4 py-2 border rounded-lg text-2xl font-bold text-center",
                placeholder: "0"
            })), React.createElement("div", null, React.createElement("label", {
                className: "block text-sm font-semibold mb-2"
            }, "Motivo"), React.createElement("input", {
                type: "text",
                value: p.lojaMovMotivo || "",
                onChange: e => x({
                    ...p,
                    lojaMovMotivo: e.target.value
                }),
                className: "w-full px-4 py-2 border rounded-lg",
                placeholder: "entrada" === p.lojaMovTipo ? "Ex: Compra de fornecedor" : "Ex: Produto danificado"
            })), React.createElement("div", {
                className: "flex gap-3 mt-6"
            }, React.createElement("button", {
                onClick: () => x({
                    ...p,
                    lojaMovModal: !1,
                    lojaMovItem: null,
                    lojaMovTipo: null,
                    lojaMovQtd: 0,
                    lojaMovMotivo: "",
                    lojaMovTamanho: ""
                }),
                className: "flex-1 px-4 py-2 bg-gray-200 text-gray-700 rounded-lg font-semibold"
            }, "Cancelar"), React.createElement("button", {
                onClick: async () => {
                    if (!p.lojaMovQtd || p.lojaMovQtd <= 0) return void ja("Informe a quantidade", "error");
                    if (p.lojaMovItem?.tem_tamanho && !p.lojaMovTamanho) return void ja("Selecione o tamanho", "error");
                    const e = "entrada" === p.lojaMovTipo ? "entrada" : "saida";
                    await fetch(`${API_URL}/loja/estoque/${p.lojaMovItem.id}/${e}`, {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json"
                        },
                        body: JSON.stringify({
                            quantidade: p.lojaMovQtd,
                            tamanho: p.lojaMovTamanho || null,
                            motivo: p.lojaMovMotivo || ("entrada" === p.lojaMovTipo ? "Entrada manual" : "Saída manual"),
                            created_by: l.fullName
                        })
                    }), ja("entrada" === p.lojaMovTipo ? "📥 Entrada registrada!" : "📤 Saída registrada!", "success"), x({
                        ...p,
                        lojaMovModal: !1,
                        lojaMovItem: null,
                        lojaMovTipo: null,
                        lojaMovQtd: 0,
                        lojaMovMotivo: "",
                        lojaMovTamanho: ""
                    }), Ja(), Qa()
                },
                className: "flex-1 px-4 py-2 text-white rounded-lg font-semibold " + ("entrada" === p.lojaMovTipo ? "bg-green-600 hover:bg-green-700" : "bg-red-600 hover:bg-red-700")
            }, "entrada" === p.lojaMovTipo ? "📥 Confirmar Entrada" : "📤 Confirmar Saída")))))), "produtos" === nt && React.createElement(React.Fragment, null, React.createElement("div", {
                className: "flex justify-between items-center mb-6"
            }, React.createElement("h2", {
                className: "text-xl font-bold text-gray-800"
            }, "🏷️ Produtos à Venda"), React.createElement("button", {
                onClick: () => {
                    Ja(), x({
                        ...p,
                        lojaProdutoModal: !0,
                        lojaProdutoEdit: null
                    })
                },
                className: "px-4 py-2 bg-purple-600 text-white rounded-lg font-semibold hover:bg-purple-700"
            }, "➕ Novo Produto")), React.createElement("div", {
                className: "grid md:grid-cols-2 lg:grid-cols-3 gap-4"
            }, 0 === Ke.length ? React.createElement("p", {
                className: "text-gray-500 text-center py-8 col-span-full"
            }, "Nenhum produto cadastrado") : Ke.map(e => React.createElement("div", {
                key: e.id,
                className: "border rounded-xl overflow-hidden hover:shadow-lg transition-shadow " + ("ativo" !== e.status ? "opacity-60" : "")
            }, e.imagem_url && React.createElement("img", {
                src: e.imagem_url,
                alt: e.nome,
                className: "w-full h-40 object-cover"
            }), React.createElement("div", {
                className: "p-4"
            }, React.createElement("div", {
                className: "flex justify-between items-start mb-2"
            }, React.createElement("h3", {
                className: "font-bold text-gray-800"
            }, e.nome), React.createElement("span", {
                className: "px-2 py-0.5 rounded text-xs font-bold " + ("ativo" === e.status ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700")
            }, "ativo" === e.status ? "Ativo" : "Inativo")), e.marca && React.createElement("p", {
                className: "text-sm text-gray-500"
            }, e.marca), React.createElement("p", {
                className: "text-xl font-bold text-green-600 mt-2"
            }, "R$ ", parseFloat(e.valor).toFixed(2).replace(".", ",")), React.createElement("div", {
                className: "mt-3 text-xs text-gray-500"
            }, e.parcelas_config && e.parcelas_config.filter(e => e && parseFloat(e.valor_parcela) > 0).length > 0 ? React.createElement("div", {
                className: "flex flex-wrap gap-1"
            }, e.parcelas_config.filter(e => e && parseFloat(e.valor_parcela) > 0).map((e, t) => React.createElement("span", {
                key: t,
                className: "bg-purple-100 text-purple-700 px-2 py-0.5 rounded"
            }, e.parcelas, "x R$ ", parseFloat(e.valor_parcela).toFixed(2).replace(".", ",")))) : React.createElement("p", {
                className: "text-gray-400"
            }, "Sem parcelas configuradas")), React.createElement("div", {
                className: "flex gap-2 mt-3"
            }, React.createElement("button", {
                onClick: () => x({
                    ...p,
                    lojaProdutoModal: !0,
                    lojaProdutoEdit: e
                }),
                className: "flex-1 px-3 py-1 bg-blue-100 text-blue-700 rounded text-xs font-semibold hover:bg-blue-200"
            }, "✏️ Editar"), React.createElement("button", {
                onClick: async () => {
                    confirm("Excluir este produto?") && (await fetch(`${API_URL}/loja/produtos/${e.id}`, {
                        method: "DELETE"
                    }), Ha(), ja("🗑️ Produto excluído!", "success"))
                },
                className: "px-3 py-1 bg-red-100 text-red-700 rounded text-xs font-semibold hover:bg-red-200"
            }, "🗑️")))))), p.lojaProdutoModal && React.createElement("div", {
                className: "fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4"
            }, React.createElement("div", {
                className: "bg-white rounded-2xl shadow-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto"
            }, React.createElement("div", {
                className: "p-6"
            }, React.createElement("h2", {
                className: "text-xl font-bold mb-4"
            }, p.lojaProdutoEdit ? "✏️ Editar Produto" : "➕ Novo Produto à Venda"), React.createElement("div", {
                className: "space-y-4"
            }, React.createElement("div", null, React.createElement("label", {
                className: "block text-sm font-semibold mb-1"
            }, "Produto do Estoque *"), React.createElement("select", {
                value: p.lojaProdutoEstoqueId ?? p.lojaProdutoEdit?.estoque_id ?? "",
                onChange: e => {
                    const t = Ze.find(t => t.id === parseInt(e.target.value));
                    x({
                        ...p,
                        lojaProdutoEstoqueId: e.target.value,
                        lojaProdutoNome: t?.nome || "",
                        lojaProdutoMarca: t?.marca || "",
                        lojaProdutoValor: t?.valor || "",
                        lojaProdutoImagem: t?.imagem_url || ""
                    })
                },
                className: "w-full px-4 py-2 border rounded-lg bg-white"
            }, React.createElement("option", {
                value: ""
            }, "Selecione..."), Ze.filter(e => "ativo" === e.status).map(e => React.createElement("option", {
                key: e.id,
                value: e.id
            }, e.nome, " - R$ ", parseFloat(e.valor).toFixed(2))))), React.createElement("div", null, React.createElement("label", {
                className: "block text-sm font-semibold mb-1"
            }, "Nome do Produto *"), React.createElement("input", {
                type: "text",
                value: p.lojaProdutoNome ?? p.lojaProdutoEdit?.nome ?? "",
                onChange: e => x({
                    ...p,
                    lojaProdutoNome: e.target.value
                }),
                className: "w-full px-4 py-2 border rounded-lg"
            })), React.createElement("div", null, React.createElement("label", {
                className: "block text-sm font-semibold mb-1"
            }, "Descrição"), React.createElement("textarea", {
                value: p.lojaProdutoDesc ?? p.lojaProdutoEdit?.descricao ?? "",
                onChange: e => x({
                    ...p,
                    lojaProdutoDesc: e.target.value
                }),
                className: "w-full px-4 py-2 border rounded-lg",
                rows: 3,
                placeholder: "Descreva o produto..."
            })), React.createElement("div", {
                className: "grid grid-cols-2 gap-4"
            }, React.createElement("div", null, React.createElement("label", {
                className: "block text-sm font-semibold mb-1"
            }, "Marca"), React.createElement("input", {
                type: "text",
                value: p.lojaProdutoMarca ?? p.lojaProdutoEdit?.marca ?? "",
                onChange: e => x({
                    ...p,
                    lojaProdutoMarca: e.target.value
                }),
                className: "w-full px-4 py-2 border rounded-lg"
            })), React.createElement("div", null, React.createElement("label", {
                className: "block text-sm font-semibold mb-1"
            }, "Valor Original (R$)"), React.createElement("input", {
                type: "number",
                step: "0.01",
                value: p.lojaProdutoValor ?? p.lojaProdutoEdit?.valor ?? "",
                onChange: e => x({
                    ...p,
                    lojaProdutoValor: e.target.value
                }),
                className: "w-full px-4 py-2 border rounded-lg"
            }))), React.createElement("div", null, React.createElement("label", {
                className: "block text-sm font-semibold mb-1"
            }, "Imagem do Produto"), React.createElement("div", {
                className: "space-y-2"
            }, (p.lojaProdutoImagem || p.lojaProdutoEdit?.imagem_url) && React.createElement("div", {
                className: "relative inline-block"
            }, React.createElement("img", {
                src: p.lojaProdutoImagem || p.lojaProdutoEdit?.imagem_url,
                alt: "Preview",
                className: "w-24 h-24 object-cover rounded-lg border"
            }), React.createElement("button", {
                type: "button",
                onClick: () => x({
                    ...p,
                    lojaProdutoImagem: ""
                }),
                className: "absolute -top-2 -right-2 w-6 h-6 bg-red-500 text-white rounded-full text-xs hover:bg-red-600"
            }, "✕")), React.createElement("div", {
                className: "flex gap-2"
            }, React.createElement("label", {
                className: "flex-1 cursor-pointer"
            }, React.createElement("div", {
                className: "px-4 py-2 bg-purple-100 text-purple-700 rounded-lg text-center font-semibold hover:bg-purple-200 transition-colors"
            }, p.uploadingImage ? "⏳ Enviando..." : "📷 Fazer Upload"), React.createElement("input", {
                type: "file",
                accept: "image/*",
                className: "hidden",
                disabled: p.uploadingImage,
                onChange: async e => {
                    const t = e.target.files?.[0];
                    if (t)
                        if (t.size > 2097152) ja("Imagem muito grande (máx 2MB)", "error");
                        else {
                            x({
                                ...p,
                                uploadingImage: !0
                            });
                            try {
                                const e = new FileReader;
                                e.onload = e => {
                                    const t = e.target.result;
                                    x({
                                        ...p,
                                        lojaProdutoImagem: t,
                                        uploadingImage: !1
                                    }), ja("✅ Imagem carregada!", "success")
                                }, e.onerror = () => {
                                    throw new Error("Erro ao ler arquivo")
                                }, e.readAsDataURL(t)
                            } catch (e) {
                                console.error("Erro upload:", e), ja("Erro ao carregar imagem", "error"), x({
                                    ...p,
                                    uploadingImage: !1
                                })
                            }
                        }
                }
            }))), React.createElement("details", {
                className: "text-sm"
            }, React.createElement("summary", {
                className: "cursor-pointer text-gray-500 hover:text-gray-700"
            }, "Ou cole uma URL"), React.createElement("input", {
                type: "text",
                placeholder: "https://...",
                value: p.lojaProdutoImagem ?? p.lojaProdutoEdit?.imagem_url ?? "",
                onChange: e => x({
                    ...p,
                    lojaProdutoImagem: e.target.value
                }),
                className: "w-full px-3 py-2 border rounded-lg mt-2 text-sm"
            })))), React.createElement("div", {
                className: "bg-purple-50 rounded-lg p-4"
            }, React.createElement("div", {
                className: "flex justify-between items-center mb-3"
            }, React.createElement("h3", {
                className: "font-bold text-purple-800"
            }, "💰 Opções de Parcelamento"), React.createElement("button", {
                type: "button",
                onClick: () => {
                    const e = p.lojaProdutoParcelas ?? (p.lojaProdutoEdit?.parcelas_config ? [...p.lojaProdutoEdit.parcelas_config] : []);
                    x({
                        ...p,
                        lojaProdutoParcelas: [...e, {
                            parcelas: 1,
                            valor_parcela: ""
                        }]
                    })
                },
                className: "px-3 py-1 bg-purple-600 text-white text-sm rounded-lg hover:bg-purple-700"
            }, "➕ Adicionar")), React.createElement("div", {
                className: "space-y-2"
            }, 0 === ((p.lojaProdutoParcelas ?? p.lojaProdutoEdit?.parcelas_config) || []).length ? React.createElement("p", {
                className: "text-sm text-gray-500 text-center py-3 bg-white rounded-lg"
            }, "Nenhuma opção de parcelamento.", React.createElement("br", null), 'Clique em "➕ Adicionar" acima.') : ((p.lojaProdutoParcelas ?? p.lojaProdutoEdit?.parcelas_config) || []).map((e, t) => React.createElement("div", {
                key: t,
                className: "flex gap-2 items-center bg-white p-3 rounded-lg border"
            }, React.createElement("div", {
                className: "w-24"
            }, React.createElement("label", {
                className: "block text-xs text-gray-500 mb-1"
            }, "Parcelas"), React.createElement("select", {
                value: e.parcelas || 1,
                onChange: e => {
                    const a = [...(p.lojaProdutoParcelas ?? p.lojaProdutoEdit?.parcelas_config) || []];
                    a[t] = {
                        ...a[t],
                        parcelas: parseInt(e.target.value)
                    }, x({
                        ...p,
                        lojaProdutoParcelas: a
                    })
                },
                className: "w-full px-2 py-1.5 border rounded text-sm bg-white"
            }, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(e => React.createElement("option", {
                key: e,
                value: e
            }, e, "x")))), React.createElement("div", {
                className: "flex-1"
            }, React.createElement("label", {
                className: "block text-xs text-gray-500 mb-1"
            }, "Valor da Parcela (R$)"), React.createElement("input", {
                type: "number",
                step: "0.01",
                value: e.valor_parcela ?? "",
                onChange: e => {
                    const a = [...(p.lojaProdutoParcelas ?? p.lojaProdutoEdit?.parcelas_config) || []];
                    a[t] = {
                        ...a[t],
                        valor_parcela: e.target.value
                    }, x({
                        ...p,
                        lojaProdutoParcelas: a
                    })
                },
                className: "w-full px-2 py-1.5 border rounded text-sm",
                placeholder: "0.00"
            })), React.createElement("div", {
                className: "w-24 text-right"
            }, React.createElement("label", {
                className: "block text-xs text-gray-500 mb-1"
            }, "Total"), React.createElement("span", {
                className: "text-sm font-bold text-green-600"
            }, "R$ ", ((e.parcelas || 1) * (parseFloat(e.valor_parcela) || 0)).toFixed(2).replace(".", ","))), React.createElement("button", {
                type: "button",
                onClick: () => {
                    const e = [...(p.lojaProdutoParcelas ?? p.lojaProdutoEdit?.parcelas_config) || []];
                    e.splice(t, 1), x({
                        ...p,
                        lojaProdutoParcelas: e
                    })
                },
                className: "p-2 text-red-500 hover:bg-red-50 rounded"
            }, "🗑️")))))), React.createElement("div", {
                className: "flex gap-3 mt-6"
            }, React.createElement("button", {
                onClick: () => x({
                    ...p,
                    lojaProdutoModal: !1,
                    lojaProdutoEdit: null,
                    lojaProdutoParcelas: null
                }),
                className: "flex-1 px-4 py-2 bg-gray-200 text-gray-700 rounded-lg font-semibold"
            }, "Cancelar"), React.createElement("button", {
                onClick: async () => {
                    const e = p.lojaProdutoNome ?? p.lojaProdutoEdit?.nome,
                        t = p.lojaProdutoValor ?? p.lojaProdutoEdit?.valor;
                    if (!e || !t) return void ja("Preencha nome e valor", "error");
                    const a = p.lojaProdutoParcelas ?? p.lojaProdutoEdit?.parcelas_config ?? [];
                    if (0 === a.length) return void ja("Adicione pelo menos uma opção de parcelamento", "error");
                    for (const e of a)
                        if (!e.valor_parcela || parseFloat(e.valor_parcela) <= 0) return void ja("Preencha o valor de todas as parcelas", "error");
                    const r = {
                        estoque_id: p.lojaProdutoEstoqueId ?? p.lojaProdutoEdit?.estoque_id,
                        nome: e,
                        descricao: p.lojaProdutoDesc ?? p.lojaProdutoEdit?.descricao ?? "",
                        marca: p.lojaProdutoMarca ?? p.lojaProdutoEdit?.marca ?? "",
                        valor: parseFloat(t),
                        imagem_url: p.lojaProdutoImagem ?? p.lojaProdutoEdit?.imagem_url ?? "",
                        parcelas_config: a.map(e => ({
                            parcelas: parseInt(e.parcelas) || 1,
                            valor_parcela: parseFloat(e.valor_parcela) || 0
                        })),
                        created_by: l.fullName
                    };
                    p.lojaProdutoEdit ? (await fetch(`${API_URL}/loja/produtos/${p.lojaProdutoEdit.id}`, {
                        method: "PUT",
                        headers: {
                            "Content-Type": "application/json"
                        },
                        body: JSON.stringify({
                            ...r,
                            status: p.lojaProdutoEdit.status
                        })
                    }), ja("✅ Produto atualizado!", "success")) : (await fetch(`${API_URL}/loja/produtos`, {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json"
                        },
                        body: JSON.stringify(r)
                    }), ja("✅ Produto adicionado!", "success")), x({
                        ...p,
                        lojaProdutoModal: !1,
                        lojaProdutoEdit: null,
                        lojaProdutoParcelas: null
                    }), Ha()
                },
                className: "flex-1 px-4 py-2 bg-purple-600 text-white rounded-lg font-semibold hover:bg-purple-700"
            }, p.lojaProdutoEdit ? "💾 Salvar" : "➕ Adicionar")))))), "pedidos" === nt && React.createElement(React.Fragment, null, React.createElement("h2", {
                className: "text-xl font-bold text-gray-800 mb-6"
            }, "🛍️ Pedidos"), React.createElement("div", {
                className: "overflow-x-auto"
            }, React.createElement("table", {
                className: "w-full text-sm"
            }, React.createElement("thead", {
                className: "bg-gray-50"
            }, React.createElement("tr", null, React.createElement("th", {
                className: "px-3 py-3 text-left"
            }, "Data"), React.createElement("th", {
                className: "px-3 py-3 text-left"
            }, "Profissional"), React.createElement("th", {
                className: "px-3 py-3 text-left"
            }, "Produto"), React.createElement("th", {
                className: "px-3 py-3 text-center"
            }, "Tam."), React.createElement("th", {
                className: "px-3 py-3 text-right"
            }, "Valor"), React.createElement("th", {
                className: "px-3 py-3 text-center"
            }, "Parcelas"), React.createElement("th", {
                className: "px-3 py-3 text-center"
            }, "Status"), React.createElement("th", {
                className: "px-3 py-3 text-center"
            }, "Débito Lançado"), React.createElement("th", {
                className: "px-3 py-3 text-center"
            }, "Ações"))), React.createElement("tbody", null, 0 === et.length ? React.createElement("tr", null, React.createElement("td", {
                colSpan: "9",
                className: "text-center py-8 text-gray-500"
            }, "Nenhum pedido")) : et.map(e => React.createElement("tr", {
                key: e.id,
                className: "border-t hover:bg-gray-50"
            }, React.createElement("td", {
                className: "px-3 py-3 text-xs"
            }, new Date(e.created_at).toLocaleDateString("pt-BR")), React.createElement("td", {
                className: "px-3 py-3"
            }, React.createElement("p", {
                className: "font-semibold text-sm"
            }, e.user_name), React.createElement("p", {
                className: "text-xs text-gray-500"
            }, "COD: ", e.user_cod)), React.createElement("td", {
                className: "px-3 py-3 text-sm"
            }, e.produto_nome), React.createElement("td", {
                className: "px-3 py-3 text-center font-bold"
            }, e.tamanho || "-"), React.createElement("td", {
                className: "px-3 py-3 text-right"
            }, React.createElement("p", {
                className: "font-bold"
            }, "R$ ", parseFloat(e.valor_final).toFixed(2).replace(".", ",")), e.parcelas > 1 && React.createElement("p", {
                className: "text-xs text-gray-500"
            }, e.parcelas, "x R$ ", parseFloat(e.valor_parcela).toFixed(2).replace(".", ","))), React.createElement("td", {
                className: "px-3 py-3 text-center text-xs"
            }, e.tipo_abatimento), React.createElement("td", {
                className: "px-3 py-3 text-center"
            }, React.createElement("span", {
                className: "px-2 py-1 rounded text-xs font-bold " + ("pendente" === e.status ? "bg-yellow-100 text-yellow-700" : "aprovado" === e.status ? "bg-green-100 text-green-700" : "rejeitado" === e.status ? "bg-red-100 text-red-700" : "bg-gray-100 text-gray-700")
            }, "pendente" === e.status ? "⏳" : "aprovado" === e.status ? "✅" : "❌"), e.observacao && "rejeitado" === e.status && React.createElement("p", {
                className: "text-xs text-red-600 mt-1 max-w-[100px] truncate",
                title: e.observacao
            }, e.observacao)), React.createElement("td", {
                className: "px-3 py-3 text-center"
            }, "aprovado" === e.status && React.createElement("div", {
                className: "flex flex-col items-center"
            }, React.createElement("input", {
                type: "checkbox",
                checked: e.debito_lancado || !1,
                onChange: async t => {
                    await fetch(`${API_URL}/loja/pedidos/${e.id}`, {
                        method: "PATCH",
                        headers: {
                            "Content-Type": "application/json"
                        },
                        body: JSON.stringify({
                            debito_lancado: t.target.checked,
                            debito_lancado_em: t.target.checked ? (new Date).toISOString() : null,
                            debito_lancado_por: t.target.checked ? l.fullName : null
                        })
                    }), Wa(), ja(t.target.checked ? "✅ Débito marcado!" : "Débito desmarcado", "success")
                },
                className: "w-5 h-5 accent-green-600"
            }), e.debito_lancado && e.debito_lancado_em && React.createElement("p", {
                className: "text-xs text-gray-500 mt-1"
            }, new Date(e.debito_lancado_em).toLocaleDateString("pt-BR"), React.createElement("br", null), new Date(e.debito_lancado_em).toLocaleTimeString("pt-BR", {
                hour: "2-digit",
                minute: "2-digit"
            }))), "aprovado" !== e.status && React.createElement("span", {
                className: "text-gray-400"
            }, "-")), React.createElement("td", {
                className: "px-3 py-3 text-center"
            }, React.createElement("div", {
                className: "flex gap-1 justify-center"
            }, "pendente" === e.status && React.createElement(React.Fragment, null, React.createElement("button", {
                onClick: async () => {
                    await fetch(`${API_URL}/loja/pedidos/${e.id}`, {
                        method: "PATCH",
                        headers: {
                            "Content-Type": "application/json"
                        },
                        body: JSON.stringify({
                            status: "aprovado",
                            admin_id: l.codProfissional,
                            admin_name: l.fullName
                        })
                    }), Wa(), ja("✅ Pedido aprovado!", "success")
                },
                className: "px-2 py-1 bg-green-600 text-white rounded text-xs hover:bg-green-700",
                title: "Aprovar"
            }, "✅"), React.createElement("button", {
                onClick: async () => {
                    const t = prompt("Motivo da rejeição:");
                    t && (await fetch(`${API_URL}/loja/pedidos/${e.id}`, {
                        method: "PATCH",
                        headers: {
                            "Content-Type": "application/json"
                        },
                        body: JSON.stringify({
                            status: "rejeitado",
                            admin_id: l.codProfissional,
                            admin_name: l.fullName,
                            observacao: t
                        })
                    }), Wa(), ja("❌ Pedido rejeitado", "success"))
                },
                className: "px-2 py-1 bg-red-600 text-white rounded text-xs hover:bg-red-700",
                title: "Rejeitar"
            }, "❌")), React.createElement("button", {
                onClick: () => x({
                    ...p,
                    lojaPedidoDeleteConfirm: e
                }),
                className: "px-2 py-1 bg-gray-600 text-white rounded text-xs hover:bg-gray-700",
                title: "Excluir"
            }, "🗑️")))))))), p.lojaPedidoDeleteConfirm && React.createElement("div", {
                className: "fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4"
            }, React.createElement("div", {
                className: "bg-white rounded-xl shadow-2xl p-6 max-w-md w-full"
            }, React.createElement("h3", {
                className: "text-xl font-bold text-red-600 mb-4"
            }, "⚠️ Excluir Pedido"), React.createElement("p", {
                className: "text-gray-700 mb-4"
            }, "Tem certeza que deseja excluir este pedido?"), React.createElement("div", {
                className: "bg-gray-50 rounded-lg p-4 mb-4"
            }, React.createElement("p", {
                className: "text-sm"
            }, React.createElement("strong", null, "Profissional:"), " ", p.lojaPedidoDeleteConfirm.user_name), React.createElement("p", {
                className: "text-sm"
            }, React.createElement("strong", null, "Produto:"), " ", p.lojaPedidoDeleteConfirm.produto_nome), React.createElement("p", {
                className: "text-sm"
            }, React.createElement("strong", null, "Valor:"), " R$ ", parseFloat(p.lojaPedidoDeleteConfirm.valor_final).toFixed(2).replace(".", ",")), React.createElement("p", {
                className: "text-sm"
            }, React.createElement("strong", null, "Status:"), " ", p.lojaPedidoDeleteConfirm.status)), React.createElement("p", {
                className: "text-red-600 text-sm mb-4 font-semibold"
            }, "Esta ação não pode ser desfeita!"), React.createElement("div", {
                className: "flex gap-3"
            }, React.createElement("button", {
                onClick: () => x({
                    ...p,
                    lojaPedidoDeleteConfirm: null
                }),
                className: "flex-1 px-4 py-2 bg-gray-200 text-gray-700 rounded-lg font-semibold hover:bg-gray-300"
            }, "Cancelar"), React.createElement("button", {
                onClick: async () => {
                    await fetch(`${API_URL}/loja/pedidos/${p.lojaPedidoDeleteConfirm.id}`, {
                        method: "DELETE"
                    }), x({
                        ...p,
                        lojaPedidoDeleteConfirm: null
                    }), Wa(), ja("🗑️ Pedido excluído!", "success")
                },
                className: "flex-1 px-4 py-2 bg-red-600 text-white rounded-lg font-semibold hover:bg-red-700"
            }, "🗑️ Excluir"))))), "sugestoes" === nt && React.createElement(React.Fragment, null, React.createElement("div", {
                className: "flex justify-between items-center mb-6"
            }, React.createElement("div", null, React.createElement("h2", {
                className: "text-xl font-bold text-gray-800"
            }, "💡 Sugestões de Produtos"), React.createElement("p", {
                className: "text-sm text-gray-500"
            }, "Veja o que os profissionais gostariam de ter na loja")), React.createElement("div", {
                className: "flex gap-2 text-sm"
            }, React.createElement("span", {
                className: "px-3 py-1 bg-yellow-100 text-yellow-700 rounded-full font-semibold"
            }, "⏳ ", ut.filter(e => "pendente" === e.status).length, " Pendentes"), React.createElement("span", {
                className: "px-3 py-1 bg-green-100 text-green-700 rounded-full font-semibold"
            }, "✅ ", ut.filter(e => "respondido" === e.status).length, " Respondidas"))), React.createElement("div", {
                className: "space-y-4"
            }, 0 === ut.length ? React.createElement("p", {
                className: "text-gray-500 text-center py-8"
            }, "Nenhuma sugestão recebida") : ut.map(e => React.createElement("div", {
                key: e.id,
                className: "border-2 rounded-xl p-4 " + ("pendente" === e.status ? "border-yellow-200 bg-yellow-50" : "respondido" === e.status ? "border-green-200 bg-green-50" : "border-red-200 bg-red-50")
            }, React.createElement("div", {
                className: "flex justify-between items-start gap-4"
            }, React.createElement("div", {
                className: "flex-1"
            }, React.createElement("div", {
                className: "flex items-center gap-2 mb-2"
            }, React.createElement("span", {
                className: "font-bold text-gray-800"
            }, e.user_name), React.createElement("span", {
                className: "text-xs text-gray-500"
            }, "COD: ", e.user_cod), React.createElement("span", {
                className: "px-2 py-0.5 rounded-full text-xs font-bold " + ("pendente" === e.status ? "bg-yellow-200 text-yellow-800" : "respondido" === e.status ? "bg-green-200 text-green-800" : "bg-red-200 text-red-800")
            }, "pendente" === e.status ? "⏳ Pendente" : "respondido" === e.status ? "✅ Respondido" : "❌ Recusado")), React.createElement("p", {
                className: "text-gray-700 bg-white p-3 rounded-lg border"
            }, e.sugestao), React.createElement("p", {
                className: "text-xs text-gray-500 mt-2"
            }, "Enviado em ", new Date(e.created_at).toLocaleDateString("pt-BR"), " às ", new Date(e.created_at).toLocaleTimeString("pt-BR", {
                hour: "2-digit",
                minute: "2-digit"
            })), e.resposta && React.createElement("div", {
                className: "mt-3 p-3 rounded-lg " + ("respondido" === e.status ? "bg-green-100" : "bg-red-100")
            }, React.createElement("p", {
                className: "text-xs font-semibold text-gray-600"
            }, "Resposta de ", e.respondido_por, ":"), React.createElement("p", {
                className: "text-sm text-gray-800 mt-1"
            }, e.resposta))), "pendente" === e.status && React.createElement("div", {
                className: "flex flex-col gap-2"
            }, React.createElement("button", {
                onClick: () => x({
                    ...p,
                    lojaSugestaoResponder: e,
                    lojaSugestaoResposta: ""
                }),
                className: "px-3 py-1.5 bg-green-600 text-white rounded-lg text-xs font-semibold hover:bg-green-700"
            }, "✅ Responder"), React.createElement("button", {
                onClick: () => x({
                    ...p,
                    lojaSugestaoRecusar: e,
                    lojaSugestaoResposta: ""
                }),
                className: "px-3 py-1.5 bg-red-600 text-white rounded-lg text-xs font-semibold hover:bg-red-700"
            }, "❌ Recusar"), React.createElement("button", {
                onClick: async () => {
                    confirm("Excluir esta sugestão?") && (await fetch(`${API_URL}/loja/sugestoes/${e.id}`, {
                        method: "DELETE"
                    }), Ya(), ja("🗑️ Sugestão excluída!", "success"))
                },
                className: "px-3 py-1.5 bg-gray-200 text-gray-700 rounded-lg text-xs font-semibold hover:bg-gray-300"
            }, "🗑️")))))), p.lojaSugestaoResponder && React.createElement("div", {
                className: "fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4"
            }, React.createElement("div", {
                className: "bg-white rounded-2xl shadow-2xl max-w-md w-full"
            }, React.createElement("div", {
                className: "bg-green-600 p-4 rounded-t-2xl text-white"
            }, React.createElement("h2", {
                className: "text-xl font-bold"
            }, "✅ Responder Sugestão")), React.createElement("div", {
                className: "p-6"
            }, React.createElement("div", {
                className: "bg-gray-50 p-3 rounded-lg mb-4"
            }, React.createElement("p", {
                className: "text-sm text-gray-600"
            }, React.createElement("strong", null, p.lojaSugestaoResponder.user_name, ":")), React.createElement("p", {
                className: "text-gray-800"
            }, p.lojaSugestaoResponder.sugestao)), React.createElement("textarea", {
                value: p.lojaSugestaoResposta || "",
                onChange: e => x({
                    ...p,
                    lojaSugestaoResposta: e.target.value
                }),
                placeholder: "Escreva sua resposta... Ex: Ótima sugestão! Vamos providenciar esse produto.",
                className: "w-full px-4 py-3 border rounded-xl h-24 resize-none"
            }), React.createElement("div", {
                className: "flex gap-3 mt-4"
            }, React.createElement("button", {
                onClick: () => x({
                    ...p,
                    lojaSugestaoResponder: null,
                    lojaSugestaoResposta: ""
                }),
                className: "flex-1 px-4 py-2 bg-gray-200 text-gray-700 rounded-lg font-semibold"
            }, "Cancelar"), React.createElement("button", {
                onClick: async () => {
                    await fetch(`${API_URL}/loja/sugestoes/${p.lojaSugestaoResponder.id}`, {
                        method: "PATCH",
                        headers: {
                            "Content-Type": "application/json"
                        },
                        body: JSON.stringify({
                            status: "respondido",
                            resposta: p.lojaSugestaoResposta || "Obrigado pela sugestão!",
                            respondido_por: l.fullName
                        })
                    }), ja("✅ Sugestão respondida!", "success"), x({
                        ...p,
                        lojaSugestaoResponder: null,
                        lojaSugestaoResposta: ""
                    }), Ya()
                },
                className: "flex-1 px-4 py-2 bg-green-600 text-white rounded-lg font-semibold hover:bg-green-700"
            }, "✅ Enviar Resposta"))))), p.lojaSugestaoRecusar && React.createElement("div", {
                className: "fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4"
            }, React.createElement("div", {
                className: "bg-white rounded-2xl shadow-2xl max-w-md w-full"
            }, React.createElement("div", {
                className: "bg-red-600 p-4 rounded-t-2xl text-white"
            }, React.createElement("h2", {
                className: "text-xl font-bold"
            }, "❌ Recusar Sugestão")), React.createElement("div", {
                className: "p-6"
            }, React.createElement("div", {
                className: "bg-gray-50 p-3 rounded-lg mb-4"
            }, React.createElement("p", {
                className: "text-sm text-gray-600"
            }, React.createElement("strong", null, p.lojaSugestaoRecusar.user_name, ":")), React.createElement("p", {
                className: "text-gray-800"
            }, p.lojaSugestaoRecusar.sugestao)), React.createElement("textarea", {
                value: p.lojaSugestaoResposta || "",
                onChange: e => x({
                    ...p,
                    lojaSugestaoResposta: e.target.value
                }),
                placeholder: "Motivo da recusa... Ex: Infelizmente não conseguimos esse produto no momento.",
                className: "w-full px-4 py-3 border rounded-xl h-24 resize-none"
            }), React.createElement("div", {
                className: "flex gap-3 mt-4"
            }, React.createElement("button", {
                onClick: () => x({
                    ...p,
                    lojaSugestaoRecusar: null,
                    lojaSugestaoResposta: ""
                }),
                className: "flex-1 px-4 py-2 bg-gray-200 text-gray-700 rounded-lg font-semibold"
            }, "Cancelar"), React.createElement("button", {
                onClick: async () => {
                    await fetch(`${API_URL}/loja/sugestoes/${p.lojaSugestaoRecusar.id}`, {
                        method: "PATCH",
                        headers: {
                            "Content-Type": "application/json"
                        },
                        body: JSON.stringify({
                            status: "recusado",
                            resposta: p.lojaSugestaoResposta || "Não foi possível atender esta sugestão.",
                            respondido_por: l.fullName
                        })
                    }), ja("❌ Sugestão recusada", "success"), x({
                        ...p,
                        lojaSugestaoRecusar: null,
                        lojaSugestaoResposta: ""
                    }), Ya()
                },
                className: "flex-1 px-4 py-2 bg-red-600 text-white rounded-lg font-semibold hover:bg-red-700"
            }, "❌ Confirmar Recusa"))))))))), "relatorios" === p.finTab && React.createElement(React.Fragment, null, (() => {
                const e = new Date,
                    t = e.getMonth(),
                    a = e.getFullYear(),
                    l = void 0 !== p.relMes ? parseInt(p.relMes) : t,
                    r = void 0 !== p.relAno ? parseInt(p.relAno) : a,
                    o = e => {
                        const t = new Date(e),
                            a = t.getDay(),
                            l = t.getHours() + t.getMinutes() / 60;
                        return 0 !== a && (6 === a ? l >= 9 && l < 12 : l >= 9 && l < 18)
                    },
                    c = q.filter(e => {
                        const t = new Date(e.created_at);
                        return t.getMonth() === l && t.getFullYear() === r
                    }),
                    s = c.filter(e => "aprovado" === e.status || "aprovado_gratuidade" === e.status),
                    n = c.filter(e => "aprovado" === e.status),
                    m = c.filter(e => "aprovado_gratuidade" === e.status),
                    i = 2025,
                    d = e => {
                        const t = new Date(e);
                        return t.getFullYear() > i || !(t.getFullYear() < i) && (t.getMonth() > 11 || !(t.getMonth() < 11) && t.getDate() >= 13)
                    },
                    u = s.filter(e => !(!e.updated_at || !e.created_at) && (!!o(e.created_at) && !!d(e.created_at))).map(e => (new Date(e.updated_at) - new Date(e.created_at)) / 6e4).filter(e => e > 0 && e <= 1440),
                    g = u.length > 0 ? Math.round(u.reduce((e, t) => e + t, 0) / u.length) : 0,
                    b = s.filter(e => {
                        if (!e.updated_at || !e.created_at || !o(e.created_at)) return !1;
                        if (!d(e.created_at)) return !1;
                        const t = (new Date(e.updated_at) - new Date(e.created_at)) / 6e4;
                        return t > 60 && t <= 1440
                    }),
                    R = [],
                    E = new Date(r, l + 1, 0).getDate();
                for (let e = 1; e <= E; e++) {
                    if (r === i && 11 === l && e < 13) {
                        R.push({
                            dia: e,
                            tempoMedio: 0,
                            qtd: 0
                        });
                        continue
                    }
                    const t = s.filter(t => new Date(t.created_at).getDate() === e && o(t.created_at)),
                        a = t.filter(e => e.updated_at).map(e => (new Date(e.updated_at) - new Date(e.created_at)) / 6e4).filter(e => e > 0 && e <= 1440),
                        c = a.length > 0 ? Math.round(a.reduce((e, t) => e + t, 0) / a.length) : 0;
                    R.push({
                        dia: e,
                        tempoMedio: c,
                        qtd: t.length
                    })
                }
                const h = Math.max(...R.map(e => e.tempoMedio), 1),
                    f = {};
                n.forEach(e => {
                    const t = e.user_cod + "|" + e.user_name;
                    f[t] || (f[t] = {
                        cod: e.user_cod,
                        nome: e.user_name,
                        qtd: 0,
                        valor: 0,
                        lucro: 0
                    }), f[t].qtd++, f[t].valor += parseFloat(e.final_amount || 0), f[t].lucro += parseFloat(e.requested_amount || 0) - parseFloat(e.final_amount || 0)
                });
                const N = Object.values(f).sort((e, t) => t.qtd - e.qtd).slice(0, 10),
                    y = {};
                m.forEach(e => {
                    const t = e.user_cod + "|" + e.user_name;
                    y[t] || (y[t] = {
                        cod: e.user_cod,
                        nome: e.user_name,
                        qtd: 0,
                        valor: 0,
                        deixouArrecadar: 0
                    }), y[t].qtd++, y[t].valor += parseFloat(e.final_amount || 0), y[t].deixouArrecadar += .045 * parseFloat(e.requested_amount || 0)
                });
                const v = Object.values(y).sort((e, t) => t.qtd - e.qtd).slice(0, 10),
                    w = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"],
                    _ = w[l],
                    j = c.filter(e => "rejeitado" === e.status),
                    C = c.filter(e => "aguardando_aprovacao" === e.status),
                    A = c.reduce((e, t) => e + parseFloat(t.requested_amount || 0), 0),
                    S = s.reduce((e, t) => e + parseFloat(t.final_amount || 0), 0),
                    k = n.reduce((e, t) => e + (parseFloat(t.requested_amount || 0) - parseFloat(t.final_amount || 0)), 0),
                    P = m.reduce((e, t) => e + .045 * parseFloat(t.requested_amount || 0), 0),
                    T = [{
                        nome: "Semana 1",
                        dias: [1, 7]
                    }, {
                        nome: "Semana 2",
                        dias: [8, 14]
                    }, {
                        nome: "Semana 3",
                        dias: [15, 21]
                    }, {
                        nome: "Semana 4",
                        dias: [22, 31]
                    }].map(e => {
                        const t = s.filter(t => {
                            const a = new Date(t.created_at).getDate();
                            return a >= e.dias[0] && a <= e.dias[1]
                        });
                        return {
                            nome: e.nome,
                            valor: t.reduce((e, t) => e + parseFloat(t.final_amount || 0), 0),
                            qtd: t.length
                        }
                    }),
                    D = Math.max(...T.map(e => e.valor), 1),
                    L = 0 === l ? 11 : l - 1,
                    I = 0 === l ? r - 1 : r,
                    F = q.filter(e => {
                        const t = new Date(e.created_at);
                        return t.getMonth() === L && t.getFullYear() === I && ("aprovado" === e.status || "aprovado_gratuidade" === e.status)
                    }).reduce((e, t) => e + parseFloat(t.final_amount || 0), 0),
                    $ = F > 0 ? (S - F) / F * 100 : 0;
                return React.createElement(React.Fragment, null, React.createElement("div", {
                    className: "bg-white rounded-xl shadow p-4 mb-6"
                }, React.createElement("div", {
                    className: "flex flex-wrap gap-4 items-center justify-between"
                }, React.createElement("div", {
                    className: "flex gap-4 items-center"
                }, React.createElement("span", {
                    className: "font-semibold text-gray-700"
                }, "📅 Período:"), React.createElement("select", {
                    value: l,
                    onChange: e => x({
                        ...p,
                        relMes: e.target.value
                    }),
                    className: "px-4 py-2 border rounded-lg"
                }, w.map((e, t) => React.createElement("option", {
                    key: t,
                    value: t
                }, e))), React.createElement("select", {
                    value: r,
                    onChange: e => x({
                        ...p,
                        relAno: e.target.value
                    }),
                    className: "px-4 py-2 border rounded-lg"
                }, [2024, 2025, 2026].map(e => React.createElement("option", {
                    key: e,
                    value: e
                }, e)))), React.createElement("button", {
                    onClick: () => {
                        const e = `\n                        <html>\n                        <head>\n                          <title>Relatório ${_} ${r}</title>\n                          <style>\n                            body { font-family: Arial, sans-serif; padding: 40px; font-size: 12px; }\n                            h1 { color: #166534; border-bottom: 3px solid #166534; padding-bottom: 10px; }\n                            h2 { color: #374151; margin-top: 25px; }\n                            .cards { display: grid; grid-template-columns: repeat(4, 1fr); gap: 15px; margin: 20px 0; }\n                            .card { background: #f3f4f6; padding: 15px; border-radius: 8px; text-align: center; }\n                            .card-value { font-size: 20px; font-weight: bold; color: #166534; }\n                            .card-label { font-size: 11px; color: #6b7280; }\n                            table { width: 100%; border-collapse: collapse; margin-top: 15px; font-size: 11px; }\n                            th, td { border: 1px solid #d1d5db; padding: 8px; text-align: left; }\n                            th { background: #166534; color: white; }\n                            .footer { margin-top: 30px; text-align: center; color: #9ca3af; font-size: 10px; }\n                          </style>\n                        </head>\n                        <body>\n                          <h1>📊 Relatório Financeiro - ${_} ${r}</h1>\n                          <p><strong>Gerado em:</strong> ${(new Date).toLocaleString("pt-BR")}</p>\n                          <div class="cards">\n                            <div class="card"><div class="card-value">R$ ${A.toFixed(2)}</div><div class="card-label">Total Solicitado</div></div>\n                            <div class="card"><div class="card-value">R$ ${S.toFixed(2)}</div><div class="card-label">Total Pago</div></div>\n                            <div class="card"><div class="card-value" style="color:#059669">R$ ${k.toFixed(2)}</div><div class="card-label">Lucro (Taxas)</div></div>\n                            <div class="card"><div class="card-value" style="color:#dc2626">R$ ${P.toFixed(2)}</div><div class="card-label">Deixou Arrecadar</div></div>\n                          </div>\n                          <h2>📋 Detalhamento</h2>\n                          <table>\n                            <thead><tr><th>Data</th><th>Profissional</th><th>Código</th><th>Solicitado</th><th>Pago</th><th>Status</th></tr></thead>\n                            <tbody>\n                              ${c.slice(0,100).map(e=>`\n                                <tr>\n                                  <td>${new Date(e.created_at).toLocaleDateString("pt-BR")}</td>\n                                  <td>${e.user_name||"-"}</td>\n                                  <td>${e.user_cod}</td>\n                                  <td>R$ ${parseFloat(e.requested_amount).toFixed(2)}</td>\n                                  <td>R$ ${parseFloat(e.final_amount).toFixed(2)}</td>\n                                  <td>${"aprovado"===e.status?"✅":"aprovado_gratuidade"===e.status?"🎁":"rejeitado"===e.status?"❌":"⏳"}</td>\n                                </tr>\n                              `).join("")}\n                            </tbody>\n                          </table>\n                          <div class="footer"><p>Central do Entregador Tutts</p></div>\n                        </body>\n                        </html>\n                      `,
                            t = window.open("", "_blank");
                        t.document.write(e), t.document.close(), t.print()
                    },
                    className: "px-6 py-2 bg-red-600 text-white rounded-lg font-semibold hover:bg-red-700"
                }, "📄 Gerar PDF"))), React.createElement("div", {
                    className: "grid grid-cols-2 md:grid-cols-4 gap-4 mb-6"
                }, React.createElement("div", {
                    className: "bg-white rounded-xl shadow p-4"
                }, React.createElement("p", {
                    className: "text-sm text-gray-600"
                }, "Total Solicitado"), React.createElement("p", {
                    className: "text-2xl font-bold text-blue-600"
                }, er(A))), React.createElement("div", {
                    className: "bg-white rounded-xl shadow p-4"
                }, React.createElement("p", {
                    className: "text-sm text-gray-600"
                }, "Total Pago"), React.createElement("p", {
                    className: "text-2xl font-bold text-green-600"
                }, er(S))), React.createElement("div", {
                    className: "bg-white rounded-xl shadow p-4"
                }, React.createElement("p", {
                    className: "text-sm text-gray-600"
                }, "💰 Lucro (Taxas 4,5%)"), React.createElement("p", {
                    className: "text-2xl font-bold text-emerald-600"
                }, er(k))), React.createElement("div", {
                    className: "bg-white rounded-xl shadow p-4"
                }, React.createElement("p", {
                    className: "text-sm text-gray-600"
                }, "❌ Deixou Arrecadar"), React.createElement("p", {
                    className: "text-2xl font-bold text-red-600"
                }, er(P)))), React.createElement("div", {
                    className: "grid grid-cols-2 md:grid-cols-5 gap-4 mb-6"
                }, React.createElement("div", {
                    className: "bg-white rounded-xl shadow p-3 text-center"
                }, React.createElement("p", {
                    className: "text-2xl font-bold text-purple-600"
                }, c.length), React.createElement("p", {
                    className: "text-xs text-gray-600"
                }, "Total")), React.createElement("div", {
                    className: "bg-white rounded-xl shadow p-3 text-center"
                }, React.createElement("p", {
                    className: "text-2xl font-bold text-green-600"
                }, n.length), React.createElement("p", {
                    className: "text-xs text-gray-600"
                }, "Aprovados")), React.createElement("div", {
                    className: "bg-white rounded-xl shadow p-3 text-center"
                }, React.createElement("p", {
                    className: "text-2xl font-bold text-emerald-600"
                }, m.length), React.createElement("p", {
                    className: "text-xs text-gray-600"
                }, "Com Gratuidade")), React.createElement("div", {
                    className: "bg-white rounded-xl shadow p-3 text-center"
                }, React.createElement("p", {
                    className: "text-2xl font-bold text-red-600"
                }, j.length), React.createElement("p", {
                    className: "text-xs text-gray-600"
                }, "Rejeitados")), React.createElement("div", {
                    className: "bg-white rounded-xl shadow p-3 text-center"
                }, React.createElement("p", {
                    className: "text-2xl font-bold text-yellow-600"
                }, C.length), React.createElement("p", {
                    className: "text-xs text-gray-600"
                }, "Pendentes"))), React.createElement("div", {
                    className: "bg-white rounded-xl shadow p-4 mb-6"
                }, React.createElement("h3", {
                    className: "font-bold text-gray-800 mb-2"
                }, "📊 Comparativo com Mês Anterior"), React.createElement("div", {
                    className: "flex items-center gap-4 flex-wrap"
                }, React.createElement("span", null, "Mês anterior: ", React.createElement("strong", null, er(F))), React.createElement("span", null, "→"), React.createElement("span", null, "Mês atual: ", React.createElement("strong", null, er(S))), React.createElement("span", {
                    className: "px-3 py-1 rounded-full text-sm font-bold " + ($ >= 0 ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700")
                }, $ >= 0 ? "↑" : "↓", " ", Math.abs($).toFixed(1), "%"))), React.createElement("div", {
                    className: "bg-white rounded-xl shadow p-4 mb-6"
                }, React.createElement("h3", {
                    className: "font-bold text-gray-800 mb-4"
                }, "📈 Evolução por Semana"), React.createElement("div", {
                    className: "flex items-end justify-around gap-4",
                    style: {
                        height: "180px"
                    }
                }, T.map((e, t) => React.createElement("div", {
                    key: t,
                    className: "flex flex-col items-center"
                }, React.createElement("span", {
                    className: "text-xs font-semibold text-green-700 mb-1"
                }, er(e.valor)), React.createElement("div", {
                    className: "bg-gradient-to-t from-green-600 to-green-400 rounded-t w-16",
                    style: {
                        height: `${Math.max(e.valor/D*140,10)}px`
                    }
                }), React.createElement("span", {
                    className: "text-xs font-semibold mt-2"
                }, e.nome), React.createElement("span", {
                    className: "text-xs text-gray-500"
                }, e.qtd, " saque(s)"))))), React.createElement("div", {
                    className: "border-t-4 border-purple-500 pt-6 mt-6"
                }, React.createElement("h2", {
                    className: "text-xl font-bold text-purple-800 mb-4"
                }, "📊 Métricas de Atendimento")), React.createElement("div", {
                    className: "grid grid-cols-2 md:grid-cols-4 gap-4 mb-6"
                }, React.createElement("div", {
                    className: "bg-gradient-to-br from-blue-500 to-blue-600 rounded-xl shadow p-4 text-white"
                }, React.createElement("p", {
                    className: "text-blue-100 text-sm"
                }, "⏱️ Tempo Médio Geral"), React.createElement("p", {
                    className: "text-3xl font-bold"
                }, g < 60 ? `${g}min` : `${Math.floor(g/60)}h${g%60}m`), React.createElement("p", {
                    className: "text-xs text-blue-200"
                }, "de atendimento")), React.createElement("div", {
                    className: "bg-gradient-to-br from-green-500 to-green-600 rounded-xl shadow p-4 text-white"
                }, React.createElement("p", {
                    className: "text-green-100 text-sm"
                }, "✅ Total Aprovados"), React.createElement("p", {
                    className: "text-3xl font-bold"
                }, s.length), React.createElement("p", {
                    className: "text-xs text-green-200"
                }, "saques no período")), React.createElement("div", {
                    className: "bg-gradient-to-br from-red-500 to-red-600 rounded-xl shadow p-4 text-white"
                }, React.createElement("p", {
                    className: "text-red-100 text-sm"
                }, "🚨 Acima de 1h"), React.createElement("p", {
                    className: "text-3xl font-bold"
                }, b.length), React.createElement("p", {
                    className: "text-xs text-red-200"
                }, "saques demorados")), React.createElement("div", {
                    className: "bg-gradient-to-br from-purple-500 to-purple-600 rounded-xl shadow p-4 text-white"
                }, React.createElement("p", {
                    className: "text-purple-100 text-sm"
                }, "🎁 Com Gratuidade"), React.createElement("p", {
                    className: "text-3xl font-bold"
                }, m.length), React.createElement("p", {
                    className: "text-xs text-purple-200"
                }, "saques sem taxa"))), React.createElement("div", {
                    className: "bg-white rounded-xl shadow p-6 mb-6"
                }, React.createElement("h3", {
                    className: "text-lg font-bold text-gray-800 mb-4"
                }, "📊 Tempo Médio de Atendimento por Dia"), React.createElement("div", {
                    className: "overflow-x-auto"
                }, React.createElement("div", {
                    className: "flex items-end gap-1 min-w-max",
                    style: {
                        height: "200px"
                    }
                }, R.map((e, t) => React.createElement("div", {
                    key: t,
                    className: "flex flex-col items-center",
                    style: {
                        width: "28px"
                    }
                }, React.createElement("div", {
                    className: "text-xs text-gray-500 mb-1"
                }, e.tempoMedio > 0 ? `${e.tempoMedio}m` : ""), React.createElement("div", {
                    className: "w-5 rounded-t " + (e.tempoMedio > 60 ? "bg-red-500" : e.tempoMedio > 30 ? "bg-yellow-500" : "bg-green-500"),
                    style: {
                        height: `${Math.max(e.tempoMedio/h*150,e.tempoMedio>0?10:0)}px`
                    },
                    title: `Dia ${e.dia}: ${e.tempoMedio}min (${e.qtd} saques)`
                }), React.createElement("div", {
                    className: "text-xs text-gray-600 mt-1"
                }, e.dia))))), React.createElement("div", {
                    className: "flex gap-4 mt-4 text-xs"
                }, React.createElement("span", {
                    className: "flex items-center gap-1"
                }, React.createElement("span", {
                    className: "w-3 h-3 bg-green-500 rounded"
                }), " Até 30min"), React.createElement("span", {
                    className: "flex items-center gap-1"
                }, React.createElement("span", {
                    className: "w-3 h-3 bg-yellow-500 rounded"
                }), " 30-60min"), React.createElement("span", {
                    className: "flex items-center gap-1"
                }, React.createElement("span", {
                    className: "w-3 h-3 bg-red-500 rounded"
                }), " Acima de 60min"))), React.createElement("div", {
                    className: "grid md:grid-cols-2 gap-6 mb-6"
                }, React.createElement("div", {
                    className: "bg-white rounded-xl shadow p-6"
                }, React.createElement("h3", {
                    className: "text-lg font-bold text-gray-800 mb-4"
                }, "🏆 Top 10 - Mais Solicitam Saques"), 0 === N.length ? React.createElement("p", {
                    className: "text-gray-500 text-center py-4"
                }, "Nenhum dado no período") : React.createElement("div", {
                    className: "space-y-2"
                }, N.map((e, t) => React.createElement("div", {
                    key: t,
                    className: "flex items-center justify-between p-3 rounded-lg " + (0 === t ? "bg-yellow-50 border border-yellow-200" : 1 === t ? "bg-gray-100" : 2 === t ? "bg-orange-50" : "bg-gray-50")
                }, React.createElement("div", {
                    className: "flex items-center gap-3"
                }, React.createElement("span", {
                    className: "text-xl " + (0 === t ? "🥇" : 1 === t ? "🥈" : 2 === t ? "🥉" : "")
                }, t >= 3 ? `${t+1}º` : ""), React.createElement("div", null, React.createElement("p", {
                    className: "font-semibold text-gray-800"
                }, e.nome || e.cod), React.createElement("p", {
                    className: "text-xs text-gray-500"
                }, "Cód: ", e.cod))), React.createElement("div", {
                    className: "text-right"
                }, React.createElement("p", {
                    className: "font-bold text-green-600"
                }, er(e.valor)), React.createElement("p", {
                    className: "text-xs text-gray-600"
                }, e.qtd, " saques"), React.createElement("p", {
                    className: "text-xs text-blue-600"
                }, "Lucro: ", er(e.lucro))))))), React.createElement("div", {
                    className: "bg-white rounded-xl shadow p-6"
                }, React.createElement("h3", {
                    className: "text-lg font-bold text-gray-800 mb-4"
                }, "🎁 Top 10 - Saques com Gratuidade"), 0 === v.length ? React.createElement("p", {
                    className: "text-gray-500 text-center py-4"
                }, "Nenhum dado no período") : React.createElement("div", {
                    className: "space-y-2"
                }, v.map((e, t) => React.createElement("div", {
                    key: t,
                    className: "flex items-center justify-between p-3 rounded-lg " + (0 === t ? "bg-purple-50 border border-purple-200" : "bg-gray-50")
                }, React.createElement("div", {
                    className: "flex items-center gap-3"
                }, React.createElement("span", {
                    className: "text-xl " + (0 === t ? "🥇" : 1 === t ? "🥈" : 2 === t ? "🥉" : "")
                }, t >= 3 ? `${t+1}º` : ""), React.createElement("div", null, React.createElement("p", {
                    className: "font-semibold text-gray-800"
                }, e.nome || e.cod), React.createElement("p", {
                    className: "text-xs text-gray-500"
                }, "Cód: ", e.cod))), React.createElement("div", {
                    className: "text-right"
                }, React.createElement("p", {
                    className: "font-bold text-purple-600"
                }, er(e.valor)), React.createElement("p", {
                    className: "text-xs text-gray-600"
                }, e.qtd, " saques"), React.createElement("p", {
                    className: "text-xs text-red-600"
                }, "Deixou: ", er(e.deixouArrecadar)))))))), React.createElement("div", {
                    className: "bg-white rounded-xl shadow p-6"
                }, React.createElement("h3", {
                    className: "text-lg font-bold text-gray-800 mb-4"
                }, "🚨 Saques Realizados Acima de 1 Hora (", b.length, ")"), 0 === b.length ? React.createElement("p", {
                    className: "text-gray-500 text-center py-4"
                }, "✅ Nenhum saque acima de 1 hora no período!") : React.createElement("div", {
                    className: "overflow-x-auto"
                }, React.createElement("table", {
                    className: "w-full text-sm"
                }, React.createElement("thead", {
                    className: "bg-red-50"
                }, React.createElement("tr", null, React.createElement("th", {
                    className: "px-3 py-2 text-left"
                }, "Profissional"), React.createElement("th", {
                    className: "px-3 py-2 text-left"
                }, "Data"), React.createElement("th", {
                    className: "px-3 py-2 text-right"
                }, "Valor"), React.createElement("th", {
                    className: "px-3 py-2 text-right"
                }, "Tempo"))), React.createElement("tbody", null, b.slice(0, 20).map((e, t) => {
                    const a = Math.round((new Date(e.updated_at) - new Date(e.created_at)) / 6e4);
                    return React.createElement("tr", {
                        key: t,
                        className: "border-b hover:bg-red-50"
                    }, React.createElement("td", {
                        className: "px-3 py-2"
                    }, React.createElement("p", {
                        className: "font-semibold"
                    }, e.user_name), React.createElement("p", {
                        className: "text-xs text-gray-500"
                    }, e.user_cod)), React.createElement("td", {
                        className: "px-3 py-2"
                    }, new Date(e.created_at).toLocaleDateString("pt-BR")), React.createElement("td", {
                        className: "px-3 py-2 text-right"
                    }, er(e.final_amount)), React.createElement("td", {
                        className: "px-3 py-2 text-right"
                    }, React.createElement("span", {
                        className: "px-2 py-1 bg-red-100 text-red-700 rounded font-semibold"
                    }, a < 60 ? `${a}min` : `${Math.floor(a/60)}h${a%60}m`)))
                }))), b.length > 20 && React.createElement("p", {
                    className: "text-center text-gray-500 text-sm mt-2"
                }, "Mostrando 20 de ", b.length, " registros"))))
            })()), "horarios" === p.finTab && React.createElement(React.Fragment, null, Me.loading ? React.createElement("div", {
                className: "flex items-center justify-center py-12"
            }, React.createElement("div", {
                className: "animate-spin rounded-full h-8 w-8 border-b-2 border-green-600"
            }), React.createElement("span", {
                className: "ml-3"
            }, "Carregando...")) : React.createElement("div", {
                className: "space-y-6"
            }, React.createElement("div", {
                className: "bg-white rounded-xl shadow p-4"
            }, React.createElement("h3", {
                className: "font-bold text-gray-800 mb-4"
            }, "🕐 Horários de Atendimento"), React.createElement("p", {
                className: "text-sm text-gray-600 mb-4"
            }, "Configure os horários de funcionamento para cada dia da semana."), React.createElement("div", {
                className: "space-y-2"
            }, Me.horarios.map(e => React.createElement("div", {
                key: e.id,
                className: "flex items-center gap-3 p-3 bg-gray-50 rounded-lg"
            }, React.createElement("div", {
                className: "w-32 font-semibold text-sm"
            }, bl[e.dia_semana]), React.createElement("label", {
                className: "flex items-center gap-2"
            }, React.createElement("input", {
                type: "checkbox",
                checked: e.ativo,
                onChange: t => Rl(e.id, {
                    ...e,
                    ativo: t.target.checked
                }),
                className: "w-4 h-4"
            }), React.createElement("span", {
                className: "text-sm"
            }, "Aberto")), e.ativo && React.createElement(React.Fragment, null, React.createElement("input", {
                type: "time",
                value: e.hora_inicio || "09:00",
                onChange: t => Rl(e.id, {
                    ...e,
                    hora_inicio: t.target.value
                }),
                className: "px-2 py-1 border rounded text-sm"
            }), React.createElement("span", {
                className: "text-gray-500"
            }, "às"), React.createElement("input", {
                type: "time",
                value: e.hora_fim || "18:00",
                onChange: t => Rl(e.id, {
                    ...e,
                    hora_fim: t.target.value
                }),
                className: "px-2 py-1 border rounded text-sm"
            })), !e.ativo && React.createElement("span", {
                className: "text-red-500 text-sm font-semibold"
            }, "FECHADO"))))), React.createElement("div", {
                className: "bg-white rounded-xl shadow p-4"
            }, React.createElement("h3", {
                className: "font-bold text-gray-800 mb-4"
            }, "📅 Horários Especiais (Feriados, Datas específicas)"), React.createElement("div", {
                className: "bg-blue-50 p-4 rounded-lg mb-4"
            }, React.createElement("div", {
                className: "grid grid-cols-1 md:grid-cols-5 gap-3"
            }, React.createElement("input", {
                type: "date",
                value: p.novoEspData || "",
                onChange: e => x(t => ({
                    ...t,
                    novoEspData: e.target.value
                })),
                className: "px-3 py-2 border rounded text-sm"
            }), React.createElement("input", {
                type: "text",
                placeholder: "Descrição (ex: Feriado)",
                value: p.novoEspDesc || "",
                onChange: e => x(t => ({
                    ...t,
                    novoEspDesc: e.target.value
                })),
                className: "px-3 py-2 border rounded text-sm"
            }), React.createElement("label", {
                className: "flex items-center gap-2"
            }, React.createElement("input", {
                type: "checkbox",
                checked: p.novoEspFechado || !1,
                onChange: e => x(t => ({
                    ...t,
                    novoEspFechado: e.target.checked
                })),
                className: "w-4 h-4"
            }), React.createElement("span", {
                className: "text-sm"
            }, "Fechado")), !p.novoEspFechado && React.createElement("div", {
                className: "flex items-center gap-2"
            }, React.createElement("input", {
                type: "time",
                value: p.novoEspInicio || "09:00",
                onChange: e => x(t => ({
                    ...t,
                    novoEspInicio: e.target.value
                })),
                className: "px-2 py-1 border rounded text-sm w-24"
            }), React.createElement("span", null, "às"), React.createElement("input", {
                type: "time",
                value: p.novoEspFim || "18:00",
                onChange: e => x(t => ({
                    ...t,
                    novoEspFim: e.target.value
                })),
                className: "px-2 py-1 border rounded text-sm w-24"
            })), React.createElement("button", {
                onClick: El,
                className: "px-4 py-2 bg-blue-600 text-white rounded font-semibold text-sm hover:bg-blue-700"
            }, "+ Adicionar"))), 0 === Me.especiais.length ? React.createElement("p", {
                className: "text-gray-500 text-sm"
            }, "Nenhum horário especial programado.") : React.createElement("div", {
                className: "space-y-2"
            }, Me.especiais.map(e => {
                let t = "Data inválida";
                try {
                    console.log("esp.data original:", e.data, typeof e.data);
                    let a = e.data;
                    if (a && "object" == typeof a && (a = a.toISOString ? a.toISOString() : String(a)), a) {
                        const e = String(a).substring(0, 10).split("-");
                        3 === e.length && 4 === e[0].length && (t = `${e[2]}/${e[1]}/${e[0]}`)
                    }
                } catch (t) {
                    console.error("Erro ao formatar data:", t, e.data)
                }
                return React.createElement("div", {
                    key: e.id,
                    className: "flex items-center justify-between p-3 bg-gray-50 rounded-lg"
                }, React.createElement("div", {
                    className: "flex items-center gap-4"
                }, React.createElement("span", {
                    className: "font-mono font-bold text-purple-600"
                }, t), React.createElement("span", {
                    className: "text-sm text-gray-700"
                }, e.descricao), e.fechado ? React.createElement("span", {
                    className: "px-2 py-0.5 bg-red-500 text-white text-xs rounded font-bold"
                }, "FECHADO") : React.createElement("span", {
                    className: "text-sm text-green-600 font-semibold"
                }, e.hora_inicio, " às ", e.hora_fim)), React.createElement("button", {
                    onClick: () => (async e => {
                        if (confirm("Remover este horário especial?")) try {
                            await fetch(`${API_URL}/horarios/especiais/${e}`, {
                                method: "DELETE"
                            }), ja("✅ Removido!", "success");
                            const t = await fetch(`${API_URL}/horarios/especiais`),
                                a = await t.json();
                            Oe(e => ({
                                ...e,
                                especiais: a
                            }))
                        } catch (e) {
                            ja("Erro", "error")
                        }
                    })(e.id),
                    className: "px-2 py-1 bg-red-500 text-white rounded text-xs hover:bg-red-600"
                }, "🗑️ Remover"))
            }))))), "avisos" === p.finTab && React.createElement(React.Fragment, null, qe.loading ? React.createElement("div", {
                className: "flex items-center justify-center py-12"
            }, React.createElement("div", {
                className: "animate-spin rounded-full h-8 w-8 border-b-2 border-yellow-600"
            }), React.createElement("span", {
                className: "ml-3"
            }, "Carregando...")) : React.createElement("div", {
                className: "space-y-6"
            }, React.createElement("div", {
                className: "bg-white rounded-xl shadow p-4"
            }, React.createElement("h3", {
                className: "font-bold text-gray-800 mb-4"
            }, "📢 Criar Novo Aviso"), React.createElement("p", {
                className: "text-sm text-gray-600 mb-4"
            }, "Os avisos criados aqui serão exibidos para os usuários na tela de Saque Emergencial."), React.createElement("div", {
                className: "bg-yellow-50 p-4 rounded-lg"
            }, React.createElement("div", {
                className: "grid grid-cols-1 md:grid-cols-2 gap-3 mb-3"
            }, React.createElement("input", {
                type: "text",
                placeholder: "Título do aviso",
                value: p.novoAvisoTitulo || "",
                onChange: e => x(t => ({
                    ...t,
                    novoAvisoTitulo: e.target.value
                })),
                className: "px-3 py-2 border rounded text-sm"
            }), React.createElement("select", {
                value: p.novoAvisoTipo || "info",
                onChange: e => x(t => ({
                    ...t,
                    novoAvisoTipo: e.target.value
                })),
                className: "px-3 py-2 border rounded text-sm"
            }, React.createElement("option", {
                value: "info"
            }, "ℹ️ Informativo (Azul)"), React.createElement("option", {
                value: "warning"
            }, "⚠️ Atenção (Amarelo)"), React.createElement("option", {
                value: "error"
            }, "🚨 Urgente (Vermelho)"), React.createElement("option", {
                value: "success"
            }, "✅ Positivo (Verde)"))), React.createElement("textarea", {
                placeholder: "Mensagem do aviso...",
                value: p.novoAvisoMensagem || "",
                onChange: e => x(t => ({
                    ...t,
                    novoAvisoMensagem: e.target.value
                })),
                className: "w-full px-3 py-2 border rounded text-sm mb-3",
                rows: 3
            }), React.createElement("div", {
                className: "flex items-center justify-between flex-wrap gap-3"
            }, React.createElement("label", {
                className: "flex items-center gap-2"
            }, React.createElement("input", {
                type: "checkbox",
                checked: p.novoAvisoExibirFora || !1,
                onChange: e => x(t => ({
                    ...t,
                    novoAvisoExibirFora: e.target.checked
                })),
                className: "w-4 h-4"
            }), React.createElement("span", {
                className: "text-sm"
            }, "Exibir apenas fora do horário de atendimento")), React.createElement("button", {
                onClick: hl,
                className: "px-6 py-2 bg-yellow-500 text-white rounded-lg font-semibold text-sm hover:bg-yellow-600"
            }, "+ Criar Aviso")))), React.createElement("div", {
                className: "bg-white rounded-xl shadow p-4"
            }, React.createElement("h3", {
                className: "font-bold text-gray-800 mb-4"
            }, "✅ Avisos Ativos (", qe.avisos.filter(e => e.ativo).length, ")"), 0 === qe.avisos.filter(e => e.ativo).length ? React.createElement("div", {
                className: "text-center py-8 text-gray-500"
            }, React.createElement("p", {
                className: "text-4xl mb-2"
            }, "📭"), React.createElement("p", null, "Nenhum aviso ativo no momento.")) : React.createElement("div", {
                className: "space-y-3"
            }, qe.avisos.filter(e => e.ativo).map(e => React.createElement("div", {
                key: e.id,
                className: "p-4 rounded-lg border-l-4 " + ("error" === e.tipo ? "bg-red-50 border-red-500" : "warning" === e.tipo ? "bg-yellow-50 border-yellow-500" : "success" === e.tipo ? "bg-green-50 border-green-500" : "bg-blue-50 border-blue-500")
            }, React.createElement("div", {
                className: "flex items-start justify-between gap-4"
            }, React.createElement("div", {
                className: "flex-1"
            }, React.createElement("div", {
                className: "flex items-center gap-2 mb-2"
            }, React.createElement("span", {
                className: "text-lg"
            }, "error" === e.tipo ? "🚨" : "warning" === e.tipo ? "⚠️" : "success" === e.tipo ? "✅" : "ℹ️"), React.createElement("span", {
                className: "font-bold"
            }, e.titulo), e.exibir_fora_horario && React.createElement("span", {
                className: "px-2 py-0.5 bg-orange-200 text-orange-700 text-[10px] rounded-full font-semibold"
            }, "🕐 Só fora do horário")), React.createElement("p", {
                className: "text-sm text-gray-700"
            }, e.mensagem), React.createElement("p", {
                className: "text-xs text-gray-400 mt-2"
            }, "Criado em: ", new Date(e.created_at).toLocaleString("pt-BR"))), React.createElement("div", {
                className: "flex flex-col gap-2"
            }, React.createElement("button", {
                onClick: () => fl(e),
                className: "px-3 py-1.5 bg-gray-500 text-white rounded text-xs font-bold hover:bg-gray-600"
            }, "⏸️ Desativar"), React.createElement("button", {
                onClick: () => Nl(e.id),
                className: "px-3 py-1.5 bg-red-500 text-white rounded text-xs font-bold hover:bg-red-600"
            }, "🗑️ Excluir"))))))), React.createElement("div", {
                className: "bg-white rounded-xl shadow p-4"
            }, React.createElement("h3", {
                className: "font-bold text-gray-800 mb-4"
            }, "📜 Histórico de Avisos (", qe.avisos.filter(e => !e.ativo).length, ")"), 0 === qe.avisos.filter(e => !e.ativo).length ? React.createElement("div", {
                className: "text-center py-6 text-gray-400"
            }, React.createElement("p", {
                className: "text-sm"
            }, "Nenhum aviso no histórico.")) : React.createElement("div", {
                className: "space-y-2"
            }, qe.avisos.filter(e => !e.ativo).map(e => React.createElement("div", {
                key: e.id,
                className: "p-3 rounded-lg bg-gray-100 border border-gray-200 opacity-70"
            }, React.createElement("div", {
                className: "flex items-start justify-between gap-4"
            }, React.createElement("div", {
                className: "flex-1"
            }, React.createElement("div", {
                className: "flex items-center gap-2 mb-1"
            }, React.createElement("span", {
                className: "text-sm"
            }, "error" === e.tipo ? "🚨" : "warning" === e.tipo ? "⚠️" : "success" === e.tipo ? "✅" : "ℹ️"), React.createElement("span", {
                className: "font-semibold text-sm text-gray-600"
            }, e.titulo), React.createElement("span", {
                className: "px-1.5 py-0.5 bg-gray-400 text-white text-[10px] rounded"
            }, "INATIVO")), React.createElement("p", {
                className: "text-xs text-gray-500"
            }, e.mensagem), React.createElement("p", {
                className: "text-[10px] text-gray-400 mt-1"
            }, "Criado: ", new Date(e.created_at).toLocaleString("pt-BR"))), React.createElement("div", {
                className: "flex gap-2"
            }, React.createElement("button", {
                onClick: () => fl(e),
                className: "px-2 py-1 bg-green-500 text-white rounded text-xs font-bold hover:bg-green-600"
            }, "▶️ Ativar"), React.createElement("button", {
                onClick: () => Nl(e.id),
                className: "px-2 py-1 bg-red-500 text-white rounded text-xs font-bold hover:bg-red-600"
            }, "🗑️"))))))))), "backup" === p.finTab && React.createElement(React.Fragment, null, (() => {
                const e = (e, t) => {
                        const a = JSON.stringify(e, null, 2),
                            l = new Blob([a], {
                                type: "application/json"
                            }),
                            r = URL.createObjectURL(l),
                            o = document.createElement("a");
                        o.href = r, o.download = t, o.click(), URL.revokeObjectURL(r), ja(`✅ ${t} exportado com sucesso!`, "success")
                    },
                    t = (e, t, a) => {
                        const l = [t.map(e => e.label).join(";"), ...e.map(e => t.map(t => {
                                let a = e[t.key] || "";
                                return "string" == typeof a && a.includes(";") && (a = `"${a}"`), a
                            }).join(";"))].join("\n"),
                            r = new Blob(["\ufeff" + l], {
                                type: "text/csv;charset=utf-8"
                            }),
                            o = URL.createObjectURL(r),
                            c = document.createElement("a");
                        c.href = o, c.download = a, c.click(), URL.revokeObjectURL(o), ja(`✅ ${a} exportado com sucesso!`, "success")
                    },
                    a = (new Date).toISOString().split("T")[0],
                    l = [{
                        key: "id",
                        label: "ID"
                    }, {
                        key: "user_cod",
                        label: "Código"
                    }, {
                        key: "user_name",
                        label: "Nome"
                    }, {
                        key: "cpf",
                        label: "CPF"
                    }, {
                        key: "pix_key",
                        label: "Chave PIX"
                    }, {
                        key: "requested_amount",
                        label: "Valor Solicitado"
                    }, {
                        key: "final_amount",
                        label: "Valor Final"
                    }, {
                        key: "status",
                        label: "Status"
                    }, {
                        key: "reject_reason",
                        label: "Motivo Rejeição"
                    }, {
                        key: "admin_name",
                        label: "Admin"
                    }, {
                        key: "created_at",
                        label: "Data Criação"
                    }, {
                        key: "updated_at",
                        label: "Data Atualização"
                    }],
                    r = [{
                        key: "id",
                        label: "ID"
                    }, {
                        key: "codProfissional",
                        label: "Código"
                    }, {
                        key: "fullName",
                        label: "Nome"
                    }, {
                        key: "role",
                        label: "Tipo"
                    }, {
                        key: "createdAt",
                        label: "Data Cadastro"
                    }],
                    o = [{
                        key: "id",
                        label: "ID"
                    }, {
                        key: "user_cod",
                        label: "Código"
                    }, {
                        key: "user_name",
                        label: "Nome"
                    }, {
                        key: "reason",
                        label: "Motivo"
                    }, {
                        key: "created_at",
                        label: "Data"
                    }],
                    c = [{
                        key: "id",
                        label: "ID"
                    }, {
                        key: "user_cod",
                        label: "Código"
                    }, {
                        key: "user_name",
                        label: "Nome"
                    }, {
                        key: "reason",
                        label: "Motivo"
                    }, {
                        key: "created_at",
                        label: "Data"
                    }],
                    s = [{
                        key: "id",
                        label: "ID"
                    }, {
                        key: "indicador_cod",
                        label: "Cód Indicador"
                    }, {
                        key: "indicador_nome",
                        label: "Nome Indicador"
                    }, {
                        key: "indicado_nome",
                        label: "Nome Indicado"
                    }, {
                        key: "indicado_contato",
                        label: "Contato"
                    }, {
                        key: "status",
                        label: "Status"
                    }, {
                        key: "created_at",
                        label: "Data"
                    }],
                    n = {
                        data_backup: (new Date).toISOString(),
                        versao: "1.0",
                        dados: {
                            withdrawals: q,
                            users: A,
                            gratuities: Q,
                            restricted: Z,
                            indicacoes: ae
                        },
                        estatisticas: {
                            total_withdrawals: q.length,
                            total_users: A.length,
                            total_gratuities: Q.length,
                            total_restricted: Z.length,
                            total_indicacoes: ae.length
                        }
                    };
                return React.createElement("div", {
                    className: "space-y-6"
                }, React.createElement("div", {
                    className: "bg-gradient-to-r from-blue-600 to-indigo-600 rounded-xl p-6 text-white"
                }, React.createElement("h2", {
                    className: "text-2xl font-bold flex items-center gap-2"
                }, "💾 Backup e Exportação de Dados"), React.createElement("p", {
                    className: "text-blue-100 mt-2"
                }, "Exporte seus dados para manter backups seguros ou analisar em outras ferramentas.")), React.createElement("div", {
                    className: "bg-white rounded-xl shadow p-6"
                }, React.createElement("div", {
                    className: "flex items-center justify-between"
                }, React.createElement("div", null, React.createElement("h3", {
                    className: "text-lg font-bold text-gray-800 flex items-center gap-2"
                }, "🗄️ Backup Completo"), React.createElement("p", {
                    className: "text-sm text-gray-600 mt-1"
                }, "Exporta todos os dados do sistema em um único arquivo JSON."), React.createElement("div", {
                    className: "flex gap-4 mt-2 text-xs text-gray-500"
                }, React.createElement("span", null, "📋 ", q.length, " solicitações"), React.createElement("span", null, "👥 ", A.length, " usuários"), React.createElement("span", null, "🎁 ", Q.length, " gratuidades"), React.createElement("span", null, "🚫 ", Z.length, " restritos"), React.createElement("span", null, "🤝 ", ae.length, " indicações"))), React.createElement("button", {
                    onClick: () => e(n, `backup_completo_${a}.json`),
                    className: "px-6 py-3 bg-gradient-to-r from-blue-600 to-indigo-600 text-white rounded-lg font-semibold hover:from-blue-700 hover:to-indigo-700 flex items-center gap-2"
                }, "⬇️ Baixar Backup Completo"))), React.createElement("div", {
                    className: "grid grid-cols-1 md:grid-cols-2 gap-4"
                }, React.createElement("div", {
                    className: "bg-white rounded-xl shadow p-5"
                }, React.createElement("h3", {
                    className: "font-bold text-gray-800 flex items-center gap-2 mb-3"
                }, "📋 Solicitações de Saque"), React.createElement("p", {
                    className: "text-sm text-gray-600 mb-3"
                }, q.length, " registros"), React.createElement("div", {
                    className: "flex gap-2"
                }, React.createElement("button", {
                    onClick: () => t(q, l, `solicitacoes_${a}.csv`),
                    className: "flex-1 px-4 py-2 bg-green-600 text-white rounded-lg font-semibold hover:bg-green-700 text-sm"
                }, "📊 CSV"), React.createElement("button", {
                    onClick: () => e(q, `solicitacoes_${a}.json`),
                    className: "flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700 text-sm"
                }, "📄 JSON"))), React.createElement("div", {
                    className: "bg-white rounded-xl shadow p-5"
                }, React.createElement("h3", {
                    className: "font-bold text-gray-800 flex items-center gap-2 mb-3"
                }, "👥 Usuários"), React.createElement("p", {
                    className: "text-sm text-gray-600 mb-3"
                }, A.length, " registros"), React.createElement("div", {
                    className: "flex gap-2"
                }, React.createElement("button", {
                    onClick: () => t(A, r, `usuarios_${a}.csv`),
                    className: "flex-1 px-4 py-2 bg-green-600 text-white rounded-lg font-semibold hover:bg-green-700 text-sm"
                }, "📊 CSV"), React.createElement("button", {
                    onClick: () => e(A, `usuarios_${a}.json`),
                    className: "flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700 text-sm"
                }, "📄 JSON"))), React.createElement("div", {
                    className: "bg-white rounded-xl shadow p-5"
                }, React.createElement("h3", {
                    className: "font-bold text-gray-800 flex items-center gap-2 mb-3"
                }, "🎁 Gratuidades"), React.createElement("p", {
                    className: "text-sm text-gray-600 mb-3"
                }, Q.length, " registros"), React.createElement("div", {
                    className: "flex gap-2"
                }, React.createElement("button", {
                    onClick: () => t(Q, o, `gratuidades_${a}.csv`),
                    className: "flex-1 px-4 py-2 bg-green-600 text-white rounded-lg font-semibold hover:bg-green-700 text-sm"
                }, "📊 CSV"), React.createElement("button", {
                    onClick: () => e(Q, `gratuidades_${a}.json`),
                    className: "flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700 text-sm"
                }, "📄 JSON"))), React.createElement("div", {
                    className: "bg-white rounded-xl shadow p-5"
                }, React.createElement("h3", {
                    className: "font-bold text-gray-800 flex items-center gap-2 mb-3"
                }, "🚫 Lista de Restritos"), React.createElement("p", {
                    className: "text-sm text-gray-600 mb-3"
                }, Z.length, " registros"), React.createElement("div", {
                    className: "flex gap-2"
                }, React.createElement("button", {
                    onClick: () => t(Z, c, `restritos_${a}.csv`),
                    className: "flex-1 px-4 py-2 bg-green-600 text-white rounded-lg font-semibold hover:bg-green-700 text-sm"
                }, "📊 CSV"), React.createElement("button", {
                    onClick: () => e(Z, `restritos_${a}.json`),
                    className: "flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700 text-sm"
                }, "📄 JSON"))), React.createElement("div", {
                    className: "bg-white rounded-xl shadow p-5"
                }, React.createElement("h3", {
                    className: "font-bold text-gray-800 flex items-center gap-2 mb-3"
                }, "🤝 Indicações"), React.createElement("p", {
                    className: "text-sm text-gray-600 mb-3"
                }, ae.length, " registros"), React.createElement("div", {
                    className: "flex gap-2"
                }, React.createElement("button", {
                    onClick: () => t(ae, s, `indicacoes_${a}.csv`),
                    className: "flex-1 px-4 py-2 bg-green-600 text-white rounded-lg font-semibold hover:bg-green-700 text-sm"
                }, "📊 CSV"), React.createElement("button", {
                    onClick: () => e(ae, `indicacoes_${a}.json`),
                    className: "flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700 text-sm"
                }, "📄 JSON"))), React.createElement("div", {
                    className: "bg-white rounded-xl shadow p-5"
                }, React.createElement("h3", {
                    className: "font-bold text-gray-800 flex items-center gap-2 mb-3"
                }, "🔍 Solicitações por Status"), React.createElement("div", {
                    className: "space-y-2"
                }, React.createElement("button", {
                    onClick: () => t(q.filter(e => "aprovado" === e.status || "aprovado_gratuidade" === e.status), l, `aprovados_${a}.csv`),
                    className: "w-full px-4 py-2 bg-green-100 text-green-700 rounded-lg font-semibold hover:bg-green-200 text-sm text-left"
                }, "✅ Aprovados (", q.filter(e => "aprovado" === e.status || "aprovado_gratuidade" === e.status).length, ")"), React.createElement("button", {
                    onClick: () => t(q.filter(e => "aguardando_aprovacao" === e.status), l, `pendentes_${a}.csv`),
                    className: "w-full px-4 py-2 bg-yellow-100 text-yellow-700 rounded-lg font-semibold hover:bg-yellow-200 text-sm text-left"
                }, "⏳ Pendentes (", q.filter(e => "aguardando_aprovacao" === e.status).length, ")"), React.createElement("button", {
                    onClick: () => t(q.filter(e => "rejeitado" === e.status), l, `rejeitados_${a}.csv`),
                    className: "w-full px-4 py-2 bg-red-100 text-red-700 rounded-lg font-semibold hover:bg-red-200 text-sm text-left"
                }, "❌ Rejeitados (", q.filter(e => "rejeitado" === e.status).length, ")")))), React.createElement("div", {
                    className: "bg-amber-50 border border-amber-200 rounded-xl p-4"
                }, React.createElement("h4", {
                    className: "font-semibold text-amber-800 flex items-center gap-2"
                }, "💡 Dicas de Backup"), React.createElement("ul", {
                    className: "text-sm text-amber-700 mt-2 space-y-1"
                }, React.createElement("li", null, "• Faça backups regularmente (recomendado: semanalmente)"), React.createElement("li", null, "• O arquivo JSON pode ser usado para restaurar dados"), React.createElement("li", null, "• O arquivo CSV pode ser aberto no Excel ou Google Sheets"), React.createElement("li", null, "• Guarde os backups em local seguro (Google Drive, OneDrive, etc.)"))))
            })())))
        }
        if (("admin_master" === l.role || "admin" === l.role) && "todo" === Ee) {
            return React.createElement("div", {
                className: "min-h-screen bg-gray-100 flex"
            }, i && React.createElement(Toast, i), todoLoading && React.createElement("div", {
                className: "fixed inset-0 bg-black/50 flex items-center justify-center z-50"
            }, React.createElement("div", {
                className: "bg-white rounded-xl p-6 text-center"
            }, React.createElement("div", {
                className: "animate-spin w-8 h-8 border-4 border-purple-600 border-t-transparent rounded-full mx-auto mb-3"
            }), React.createElement("p", null, "Carregando TO-DO..."))), React.createElement("div", {
                className: "w-72 bg-white shadow-lg flex flex-col"
            }, React.createElement("div", {
                className: "bg-gradient-to-r from-purple-600 to-indigo-600 p-4 text-white"
            }, React.createElement("h1", {
                className: "text-xl font-bold flex items-center gap-2"
            }, "📋 TO-DO Tutts"), React.createElement("p", {
                className: "text-purple-200 text-sm"
            }, "Gestão de Tarefas")), React.createElement("div", {
                className: "flex border-b"
            }, React.createElement("button", {
                onClick: () => setTodoTab("tarefas"),
                className: "flex-1 py-3 text-sm font-semibold " + (todoTab === "tarefas" ? "text-purple-600 border-b-2 border-purple-600" : "text-gray-500")
            }, "📝 Tarefas"), "admin_master" === l.role && React.createElement("button", {
                onClick: () => setTodoTab("metricas"),
                className: "flex-1 py-3 text-sm font-semibold " + (todoTab === "metricas" ? "text-purple-600 border-b-2 border-purple-600" : "text-gray-500")
            }, "📊 Métricas")), React.createElement("div", {
                className: "flex-1 overflow-y-auto p-3"
            }, React.createElement("div", {
                className: "flex justify-between items-center mb-3"
            }, React.createElement("span", {
                className: "text-xs font-semibold text-gray-500 uppercase"
            }, "Grupos"), React.createElement("button", {
                onClick: () => setTodoModal({
                    tipo: "novoGrupo"
                }),
                className: "text-purple-600 hover:bg-purple-50 p-1 rounded"
            }, "➕")), todoGrupos.map(g => React.createElement("button", {
                key: g.id,
                onClick: async () => {
                    setTodoGrupoAtivo(g);
                    setTodoLoading(true);
                    const tarefas = await loadTodoTarefas(g.id, todoFiltroStatus);
                    setTodoTarefas(tarefas);
                    setTodoLoading(false)
                },
                className: "w-full text-left px-3 py-2 rounded-lg mb-1 flex items-center gap-2 transition-all " + (todoGrupoAtivo?.id === g.id ? "bg-purple-100 text-purple-700" : "hover:bg-gray-100")
            }, React.createElement("span", null, g.icone || "📋"), React.createElement("span", {
                className: "flex-1 truncate"
            }, g.nome), g.tipo === "pessoal" && React.createElement("span", {
                className: "text-xs bg-yellow-100 text-yellow-700 px-1 rounded"
            }, "Pessoal")))), React.createElement("div", {
                className: "p-3 border-t"
            }, React.createElement("button", {
                onClick: () => he("solicitacoes"),
                className: "w-full py-2 bg-gray-100 text-gray-700 rounded-lg font-semibold hover:bg-gray-200"
            }, "← Voltar ao Painel"))), React.createElement("div", {
                className: "flex-1 p-6 overflow-y-auto"
            }, todoTab === "tarefas" && React.createElement(React.Fragment, null, React.createElement("div", {
                className: "flex justify-between items-center mb-6"
            }, React.createElement("div", null, React.createElement("h2", {
                className: "text-2xl font-bold text-gray-800"
            }, todoGrupoAtivo?.icone, " ", todoGrupoAtivo?.nome || "Selecione um Grupo"), React.createElement("p", {
                className: "text-gray-500"
            }, todoTarefas.length, " tarefa(s)")), React.createElement("div", {
                className: "flex gap-3"
            }, React.createElement("select", {
                value: todoFiltroStatus,
                onChange: async (e) => {
                    setTodoFiltroStatus(e.target.value);
                    if (todoGrupoAtivo) {
                        setTodoLoading(true);
                        const tarefas = await loadTodoTarefas(todoGrupoAtivo.id, e.target.value);
                        setTodoTarefas(tarefas);
                        setTodoLoading(false)
                    }
                },
                className: "px-3 py-2 border rounded-lg bg-white"
            }, React.createElement("option", {
                value: "todas"
            }, "Todas"), React.createElement("option", {
                value: "pendente"
            }, "Pendentes"), React.createElement("option", {
                value: "em_andamento"
            }, "Em Andamento"), React.createElement("option", {
                value: "concluida"
            }, "Concluídas")), React.createElement("button", {
                onClick: () => setTodoModal({
                    tipo: "novaTarefa"
                }),
                className: "px-4 py-2 bg-purple-600 text-white rounded-lg font-semibold hover:bg-purple-700 flex items-center gap-2",
                disabled: !todoGrupoAtivo
            }, "➕ Nova Tarefa"))), React.createElement("div", {
                className: "space-y-3"
            }, todoTarefas.length === 0 ? React.createElement("div", {
                className: "bg-white rounded-xl shadow p-8 text-center"
            }, React.createElement("div", {
                className: "text-6xl mb-4"
            }, "📭"), React.createElement("p", {
                className: "text-gray-500"
            }, "Nenhuma tarefa encontrada"), React.createElement("button", {
                onClick: () => setTodoModal({
                    tipo: "novaTarefa"
                }),
                className: "mt-4 px-4 py-2 bg-purple-600 text-white rounded-lg font-semibold",
                disabled: !todoGrupoAtivo
            }, "Criar primeira tarefa")) : todoTarefas.map(t => React.createElement("div", {
                key: t.id,
                className: "bg-white rounded-xl shadow-sm hover:shadow-md transition-all p-4 border-l-4 " + (t.status === "concluida" ? "border-green-500 bg-green-50/30" : t.prioridade === "alta" || t.prioridade === "urgente" ? "border-red-500" : t.prioridade === "baixa" ? "border-gray-300" : "border-yellow-500")
            }, React.createElement("div", {
                className: "flex items-start gap-3"
            }, React.createElement("button", {
                onClick: async () => {
                    const novoStatus = t.status === "concluida" ? "pendente" : "concluida";
                    await fetch(`${API_URL}/todo/tarefas/${t.id}`, {
                        method: "PUT",
                        headers: {
                            "Content-Type": "application/json"
                        },
                        body: JSON.stringify({
                            status: novoStatus,
                            user_cod: l.codProfissional,
                            user_name: l.fullName
                        })
                    });
                    const tarefas = await loadTodoTarefas(todoGrupoAtivo.id, todoFiltroStatus);
                    setTodoTarefas(tarefas);
                    ja(novoStatus === "concluida" ? "✅ Tarefa concluída!" : "Tarefa reaberta", "success")
                },
                className: "mt-1 w-6 h-6 rounded-full border-2 flex items-center justify-center transition-all " + (t.status === "concluida" ? "bg-green-500 border-green-500 text-white" : "border-gray-300 hover:border-purple-500")
            }, t.status === "concluida" && "✓"), React.createElement("div", {
                className: "flex-1"
            }, React.createElement("div", {
                className: "flex items-center gap-2 mb-1"
            }, React.createElement("h3", {
                className: "font-semibold text-gray-800 " + (t.status === "concluida" ? "line-through text-gray-500" : "")
            }, t.titulo), t.tipo === "pessoal" && React.createElement("span", {
                className: "text-xs bg-yellow-100 text-yellow-700 px-2 py-0.5 rounded"
            }, "Pessoal"), t.recorrente && React.createElement("span", {
                className: "text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded"
            }, "🔄")), t.descricao && React.createElement("p", {
                className: "text-sm text-gray-600 mb-2"
            }, t.descricao.substring(0, 100)), React.createElement("div", {
                className: "flex flex-wrap items-center gap-3 text-xs text-gray-500"
            }, t.data_prazo && React.createElement("span", {
                className: "flex items-center gap-1 " + (new Date(t.data_prazo) < new Date() && t.status !== "concluida" ? "text-red-600 font-semibold" : "")
            }, "📅 ", new Date(t.data_prazo).toLocaleDateString("pt-BR")), t.responsaveis?.length > 0 && React.createElement("span", {
                className: "flex items-center gap-1"
            }, "👤 ", t.responsaveis.slice(0, 2).map(r => r?.user_name?.split(" ")[0]).filter(Boolean).join(", ")), parseInt(t.qtd_comentarios) > 0 && React.createElement("span", {
                className: "flex items-center gap-1"
            }, "💬 ", t.qtd_comentarios), React.createElement("span", {
                className: "px-2 py-0.5 rounded " + (t.prioridade === "alta" || t.prioridade === "urgente" ? "bg-red-100 text-red-700" : t.prioridade === "baixa" ? "bg-gray-100 text-gray-600" : "bg-yellow-100 text-yellow-700")
            }, t.prioridade === "alta" || t.prioridade === "urgente" ? "🔴 Alta" : t.prioridade === "baixa" ? "⚪ Baixa" : "🟡 Média"))), React.createElement("div", {
                className: "flex gap-1"
            }, React.createElement("button", {
                onClick: () => setTodoModal({
                    tipo: "editarTarefa",
                    tarefa: t
                }),
                className: "p-2 text-gray-400 hover:text-purple-600 hover:bg-purple-50 rounded"
            }, "✏️"), React.createElement("button", {
                onClick: async () => {
                    if (confirm("Excluir esta tarefa?")) {
                        await fetch(`${API_URL}/todo/tarefas/${t.id}`, {
                            method: "DELETE"
                        });
                        const tarefas = await loadTodoTarefas(todoGrupoAtivo.id, todoFiltroStatus);
                        setTodoTarefas(tarefas);
                        ja("🗑️ Tarefa excluída", "success")
                    }
                },
                className: "p-2 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded"
            }, "🗑️"))))))), todoTab === "metricas" && "admin_master" === l.role && todoMetricas && React.createElement(React.Fragment, null, React.createElement("h2", {
                className: "text-2xl font-bold text-gray-800 mb-6"
            }, "📊 Métricas de Produtividade"), React.createElement("div", {
                className: "grid grid-cols-4 gap-4 mb-6"
            }, React.createElement("div", {
                className: "bg-white rounded-xl shadow p-4"
            }, React.createElement("p", {
                className: "text-gray-500 text-sm"
            }, "Total de Tarefas"), React.createElement("p", {
                className: "text-3xl font-bold text-gray-800"
            }, todoMetricas.totais?.total || 0)), React.createElement("div", {
                className: "bg-white rounded-xl shadow p-4"
            }, React.createElement("p", {
                className: "text-gray-500 text-sm"
            }, "Concluídas"), React.createElement("p", {
                className: "text-3xl font-bold text-green-600"
            }, todoMetricas.totais?.concluidas || 0)), React.createElement("div", {
                className: "bg-white rounded-xl shadow p-4"
            }, React.createElement("p", {
                className: "text-gray-500 text-sm"
            }, "No Prazo"), React.createElement("p", {
                className: "text-3xl font-bold text-blue-600"
            }, todoMetricas.totais?.no_prazo || 0)), React.createElement("div", {
                className: "bg-white rounded-xl shadow p-4"
            }, React.createElement("p", {
                className: "text-gray-500 text-sm"
            }, "Vencidas"), React.createElement("p", {
                className: "text-3xl font-bold text-red-600"
            }, todoMetricas.totais?.vencidas || 0))), React.createElement("div", {
                className: "grid grid-cols-2 gap-6"
            }, React.createElement("div", {
                className: "bg-white rounded-xl shadow p-6"
            }, React.createElement("h3", {
                className: "font-semibold mb-4"
            }, "🏆 Ranking de Conclusões"), React.createElement("div", {
                className: "space-y-3"
            }, todoMetricas.porResponsavel?.slice(0, 10).map((u, i) => React.createElement("div", {
                key: u.user_cod || i,
                className: "flex items-center gap-3 p-2 rounded-lg " + (i < 3 ? "bg-yellow-50" : "")
            }, React.createElement("span", {
                className: "text-xl"
            }, i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : i + 1), React.createElement("div", {
                className: "flex-1"
            }, React.createElement("p", {
                className: "font-semibold"
            }, u.user_name || "—"), React.createElement("p", {
                className: "text-xs text-gray-500"
            }, u.total_concluidas, " concluídas")), React.createElement("div", {
                className: "text-right"
            }, React.createElement("p", {
                className: "text-lg font-bold text-green-600"
            }, u.total_concluidas > 0 ? Math.round((u.no_prazo / u.total_concluidas) * 100) : 0, "%")))))), React.createElement("div", {
                className: "bg-white rounded-xl shadow p-6"
            }, React.createElement("h3", {
                className: "font-semibold mb-4"
            }, "📁 Por Grupo"), React.createElement("div", {
                className: "space-y-3"
            }, todoMetricas.porGrupo?.map(g => React.createElement("div", {
                key: g.id,
                className: "flex items-center gap-3 p-2"
            }, React.createElement("span", {
                className: "text-xl"
            }, g.icone || "📋"), React.createElement("div", {
                className: "flex-1"
            }, React.createElement("p", {
                className: "font-semibold"
            }, g.nome), React.createElement("div", {
                className: "w-full bg-gray-200 rounded-full h-2 mt-1"
            }, React.createElement("div", {
                className: "bg-green-500 h-2 rounded-full",
                style: {
                    width: `${g.total>0?(g.concluidas/g.total)*100:0}%`
                }
            }))), React.createElement("div", {
                className: "text-right text-sm"
            }, React.createElement("span", {
                className: "text-green-600 font-semibold"
            }, g.concluidas), React.createElement("span", {
                className: "text-gray-400"
            }, "/", g.total))))))))), todoModal && React.createElement("div", {
                className: "fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4"
            }, todoModal.tipo === "novoGrupo" && React.createElement("div", {
                className: "bg-white rounded-2xl shadow-2xl max-w-md w-full"
            }, React.createElement("div", {
                className: "bg-gradient-to-r from-purple-600 to-indigo-600 p-4 rounded-t-2xl text-white"
            }, React.createElement("h2", {
                className: "text-xl font-bold"
            }, "📁 Novo Grupo")), React.createElement("div", {
                className: "p-6 space-y-4"
            }, React.createElement("div", null, React.createElement("label", {
                className: "block text-sm font-semibold mb-1"
            }, "Nome do Grupo *"), React.createElement("input", {
                type: "text",
                value: todoModal.nome || "",
                onChange: e => setTodoModal({
                    ...todoModal,
                    nome: e.target.value
                }),
                className: "w-full px-3 py-2 border rounded-lg",
                placeholder: "Ex: TO-DO Monitoramento"
            })), React.createElement("div", {
                className: "grid grid-cols-2 gap-4"
            }, React.createElement("div", null, React.createElement("label", {
                className: "block text-sm font-semibold mb-1"
            }, "Ícone"), React.createElement("select", {
                value: todoModal.icone || "📋",
                onChange: e => setTodoModal({
                    ...todoModal,
                    icone: e.target.value
                }),
                className: "w-full px-3 py-2 border rounded-lg bg-white"
            }, ["📋", "📊", "🎯", "🚀", "💼", "📁", "⭐", "🔔", "📌", "✅", "🛠️", "💡", "🔥", "📈", "🎨", "🏆", "⚡", "🔒"].map(ic => React.createElement("option", {
                key: ic,
                value: ic
            }, ic)))), React.createElement("div", null, React.createElement("label", {
                className: "block text-sm font-semibold mb-1"
            }, "Tipo"), React.createElement("select", {
                value: todoModal.tipoGrupo || "compartilhado",
                onChange: e => setTodoModal({
                    ...todoModal,
                    tipoGrupo: e.target.value
                }),
                className: "w-full px-3 py-2 border rounded-lg bg-white"
            }, React.createElement("option", {
                value: "compartilhado"
            }, "👥 Compartilhado"), React.createElement("option", {
                value: "pessoal"
            }, "🔒 Pessoal")))), React.createElement("div", {
                className: "flex gap-3 pt-4"
            }, React.createElement("button", {
                onClick: () => setTodoModal(null),
                className: "flex-1 px-4 py-2 bg-gray-200 text-gray-700 rounded-lg font-semibold"
            }, "Cancelar"), React.createElement("button", {
                onClick: async () => {
                    if (!todoModal.nome?.trim()) {
                        ja("Informe o nome do grupo", "error");
                        return
                    }
                    await fetch(`${API_URL}/todo/grupos`, {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json"
                        },
                        body: JSON.stringify({
                            nome: todoModal.nome,
                            icone: todoModal.icone || "📋",
                            tipo: todoModal.tipoGrupo || "compartilhado",
                            criado_por: l.codProfissional,
                            criado_por_nome: l.fullName
                        })
                    });
                    const grupos = await loadTodoGrupos();
                    setTodoGrupos(grupos);
                    setTodoModal(null);
                    ja("✅ Grupo criado!", "success")
                },
                className: "flex-1 px-4 py-2 bg-purple-600 text-white rounded-lg font-semibold hover:bg-purple-700"
            }, "Criar Grupo")))), (todoModal.tipo === "novaTarefa" || todoModal.tipo === "editarTarefa") && React.createElement("div", {
                className: "bg-white rounded-2xl shadow-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto"
            }, React.createElement("div", {
                className: "bg-gradient-to-r from-purple-600 to-indigo-600 p-4 rounded-t-2xl text-white sticky top-0"
            }, React.createElement("h2", {
                className: "text-xl font-bold"
            }, todoModal.tipo === "novaTarefa" ? "📝 Nova Tarefa" : "✏️ Editar Tarefa")), React.createElement("div", {
                className: "p-6 space-y-4"
            }, React.createElement("div", null, React.createElement("label", {
                className: "block text-sm font-semibold mb-1"
            }, "Título *"), React.createElement("input", {
                type: "text",
                value: todoModal.titulo || todoModal.tarefa?.titulo || "",
                onChange: e => setTodoModal({
                    ...todoModal,
                    titulo: e.target.value
                }),
                className: "w-full px-3 py-2 border rounded-lg",
                placeholder: "O que precisa ser feito?"
            })), React.createElement("div", null, React.createElement("label", {
                className: "block text-sm font-semibold mb-1"
            }, "Descrição"), React.createElement("textarea", {
                value: todoModal.descricao || todoModal.tarefa?.descricao || "",
                onChange: e => setTodoModal({
                    ...todoModal,
                    descricao: e.target.value
                }),
                className: "w-full px-3 py-2 border rounded-lg h-24",
                placeholder: "Detalhes da tarefa..."
            })), React.createElement("div", {
                className: "grid grid-cols-3 gap-4"
            }, React.createElement("div", null, React.createElement("label", {
                className: "block text-sm font-semibold mb-1"
            }, "Prioridade"), React.createElement("select", {
                value: todoModal.prioridade || todoModal.tarefa?.prioridade || "media",
                onChange: e => setTodoModal({
                    ...todoModal,
                    prioridade: e.target.value
                }),
                className: "w-full px-3 py-2 border rounded-lg bg-white"
            }, React.createElement("option", {
                value: "baixa"
            }, "⚪ Baixa"), React.createElement("option", {
                value: "media"
            }, "🟡 Média"), React.createElement("option", {
                value: "alta"
            }, "🔴 Alta"), React.createElement("option", {
                value: "urgente"
            }, "🔥 Urgente"))), React.createElement("div", null, React.createElement("label", {
                className: "block text-sm font-semibold mb-1"
            }, "Prazo"), React.createElement("input", {
                type: "datetime-local",
                value: todoModal.data_prazo || todoModal.tarefa?.data_prazo?.substring(0, 16) || "",
                onChange: e => setTodoModal({
                    ...todoModal,
                    data_prazo: e.target.value
                }),
                className: "w-full px-3 py-2 border rounded-lg"
            })), React.createElement("div", null, React.createElement("label", {
                className: "block text-sm font-semibold mb-1"
            }, "Recorrência"), React.createElement("select", {
                value: todoModal.tipo_recorrencia || todoModal.tarefa?.tipo_recorrencia || "",
                onChange: e => setTodoModal({
                    ...todoModal,
                    tipo_recorrencia: e.target.value,
                    recorrente: !!e.target.value
                }),
                className: "w-full px-3 py-2 border rounded-lg bg-white"
            }, React.createElement("option", {
                value: ""
            }, "Sem recorrência"), React.createElement("option", {
                value: "diario"
            }, "📆 Diário"), React.createElement("option", {
                value: "semanal"
            }, "📅 Semanal"), React.createElement("option", {
                value: "mensal"
            }, "🗓️ Mensal")))), React.createElement("div", null, React.createElement("label", {
                className: "block text-sm font-semibold mb-1"
            }, "Tipo"), React.createElement("div", {
                className: "flex gap-3"
            }, React.createElement("button", {
                type: "button",
                onClick: () => setTodoModal({
                    ...todoModal,
                    tipoTarefa: "compartilhado"
                }),
                className: "flex-1 py-2 rounded-lg border-2 font-semibold transition-all " + ((todoModal.tipoTarefa || todoModal.tarefa?.tipo || "compartilhado") === "compartilhado" ? "border-purple-600 bg-purple-50 text-purple-700" : "border-gray-200")
            }, "👥 Compartilhado"), React.createElement("button", {
                type: "button",
                onClick: () => setTodoModal({
                    ...todoModal,
                    tipoTarefa: "pessoal"
                }),
                className: "flex-1 py-2 rounded-lg border-2 font-semibold transition-all " + ((todoModal.tipoTarefa || todoModal.tarefa?.tipo) === "pessoal" ? "border-yellow-500 bg-yellow-50 text-yellow-700" : "border-gray-200")
            }, "🔒 Pessoal"))), todoAdmins.length > 0 && React.createElement("div", null, React.createElement("label", {
                className: "block text-sm font-semibold mb-1"
            }, "Responsáveis"), React.createElement("div", {
                className: "flex flex-wrap gap-2"
            }, todoAdmins.map(adm => React.createElement("button", {
                key: adm.cod,
                type: "button",
                onClick: () => {
                    const atual = todoModal.responsaveis || todoModal.tarefa?.responsaveis || [];
                    const existe = atual.find(r => r.user_cod === adm.cod);
                    if (existe) {
                        setTodoModal({
                            ...todoModal,
                            responsaveis: atual.filter(r => r.user_cod !== adm.cod)
                        })
                    } else {
                        setTodoModal({
                            ...todoModal,
                            responsaveis: [...atual, {
                                user_cod: adm.cod,
                                user_name: adm.nome
                            }]
                        })
                    }
                },
                className: "px-3 py-1 rounded-full text-sm font-semibold transition-all " + ((todoModal.responsaveis || todoModal.tarefa?.responsaveis || []).find(r => r.user_cod === adm.cod) ? "bg-purple-600 text-white" : "bg-gray-100 hover:bg-gray-200")
            }, adm.nome?.split(" ")[0])))), React.createElement("div", {
                className: "flex gap-3 pt-4"
            }, React.createElement("button", {
                onClick: () => setTodoModal(null),
                className: "flex-1 px-4 py-2 bg-gray-200 text-gray-700 rounded-lg font-semibold"
            }, "Cancelar"), React.createElement("button", {
                onClick: async () => {
                    const titulo = todoModal.titulo || todoModal.tarefa?.titulo;
                    if (!titulo?.trim()) {
                        ja("Informe o título", "error");
                        return
                    }
                    const payload = {
                        grupo_id: todoGrupoAtivo.id,
                        titulo,
                        descricao: todoModal.descricao || todoModal.tarefa?.descricao,
                        prioridade: todoModal.prioridade || todoModal.tarefa?.prioridade || "media",
                        data_prazo: todoModal.data_prazo || todoModal.tarefa?.data_prazo || null,
                        recorrente: todoModal.recorrente || !!todoModal.tipo_recorrencia,
                        tipo_recorrencia: todoModal.tipo_recorrencia || todoModal.tarefa?.tipo_recorrencia || null,
                        tipo: todoModal.tipoTarefa || todoModal.tarefa?.tipo || "compartilhado",
                        responsaveis: todoModal.responsaveis || todoModal.tarefa?.responsaveis || [],
                        criado_por: l.codProfissional,
                        criado_por_nome: l.fullName,
                        user_cod: l.codProfissional,
                        user_name: l.fullName
                    };
                    if (todoModal.tipo === "editarTarefa") {
                        await fetch(`${API_URL}/todo/tarefas/${todoModal.tarefa.id}`, {
                            method: "PUT",
                            headers: {
                                "Content-Type": "application/json"
                            },
                            body: JSON.stringify(payload)
                        });
                        ja("✅ Tarefa atualizada!", "success")
                    } else {
                        await fetch(`${API_URL}/todo/tarefas`, {
                            method: "POST",
                            headers: {
                                "Content-Type": "application/json"
                            },
                            body: JSON.stringify(payload)
                        });
                        ja("✅ Tarefa criada!", "success")
                    }
                    const tarefas = await loadTodoTarefas(todoGrupoAtivo.id, todoFiltroStatus);
                    setTodoTarefas(tarefas);
                    setTodoModal(null)
                },
                className: "flex-1 px-4 py-2 bg-purple-600 text-white rounded-lg font-semibold hover:bg-purple-700"
            }, todoModal.tipo === "editarTarefa" ? "Salvar Alterações" : "Criar Tarefa"))))))
        }
        // ========== MÓDULO OPERACIONAL / ATIVAÇÃO ==========
        if (("admin_master" === l.role || "admin" === l.role) && "operacional" === Ee) {
            return React.createElement("div", {
                className: "min-h-screen bg-gray-50"
            }, i && React.createElement(Toast, i), n && React.createElement(LoadingOverlay, null),
            React.createElement("nav", {
                className: "bg-gradient-to-r from-teal-700 to-teal-900 shadow-lg"
            }, React.createElement("div", {
                className: "max-w-7xl mx-auto px-4 py-4 flex justify-between items-center"
            }, React.createElement("div", {
                className: "flex items-center gap-4"
            }, React.createElement("div", null,
                React.createElement("h1", {className: "text-xl font-bold text-white"}, "⚙️ Operacional / Ativação"),
                React.createElement("p", {className: "text-xs text-teal-200"}, l.fullName)
            ), React.createElement("div", {className: "flex bg-white/10 rounded-lg p-1"},
                React.createElement("button", {
                    onClick: function() { he("solicitacoes"); },
                    className: "px-4 py-2 rounded-lg text-sm font-semibold text-white hover:bg-white/10"
                }, "📋 Solicitações"),
                "admin_master" === l.role && React.createElement("button", {
                    onClick: function() { he("financeiro"); },
                    className: "px-4 py-2 rounded-lg text-sm font-semibold text-white hover:bg-white/10"
                }, "💰 Financeiro"),
                React.createElement("button", {
                    onClick: function() { he("operacional"); },
                    className: "px-4 py-2 rounded-lg text-sm font-semibold bg-white text-teal-800"
                }, "⚙️ Operacional")
            )), React.createElement("div", {className: "flex items-center gap-3"},
                React.createElement("button", {onClick: ul, className: "px-4 py-2 bg-white/20 text-white rounded-lg hover:bg-white/30 text-sm font-semibold"}, "🔄"),
                React.createElement("button", {onClick: function() { o(null); }, className: "px-4 py-2 text-white hover:bg-white/20 rounded-lg"}, "Sair")
            ))),
            React.createElement("div", {className: "bg-white border-b sticky top-0 z-10"},
                React.createElement("div", {className: "max-w-7xl mx-auto px-4 flex gap-1 overflow-x-auto"},
                    React.createElement("button", {
                        onClick: function() { he("financeiro"); x({finTab: "indicacoes"}); },
                        className: "px-4 py-2.5 text-sm font-semibold whitespace-nowrap " + ((p.opTab || "indicacoes") === "indicacoes" ? "text-teal-700 border-b-2 border-teal-600 bg-teal-50" : "text-gray-600 hover:bg-gray-100")
                    }, "👥 Indicação"),
                    React.createElement("button", {
                        onClick: function() { he("financeiro"); x({finTab: "promo-novatos"}); },
                        className: "px-4 py-2.5 text-sm font-semibold whitespace-nowrap " + (p.opTab === "promo-novatos" ? "text-teal-700 border-b-2 border-teal-600 bg-teal-50" : "text-gray-600 hover:bg-gray-100")
                    }, "🚀 Promo Novato")
                )
            ),
            React.createElement("div", {className: "max-w-7xl mx-auto p-6 text-center"},
                React.createElement("div", {className: "bg-teal-50 border border-teal-200 rounded-xl p-8"},
                    React.createElement("span", {className: "text-5xl mb-4 block"}, "⚙️"),
                    React.createElement("h2", {className: "text-xl font-bold text-teal-800 mb-2"}, "Módulo Operacional / Ativação"),
                    React.createElement("p", {className: "text-teal-600 mb-4"}, "Selecione uma das opções acima para gerenciar Indicações ou Promo Novatos."),
                    React.createElement("p", {className: "text-sm text-teal-500"}, "As funcionalidades são as mesmas do módulo Financeiro, centralizadas aqui para facilitar o acesso operacional.")
                )
            ));
        }
        if ("admin_master" === l.role && "bi" === Ee) {
            return React.createElement("div", {
                className: "min-h-screen bg-gray-100"
            }, i && React.createElement(Toast, i), n && React.createElement(LoadingOverlay, null), React.createElement("nav", {
                className: "bg-gradient-to-r from-purple-700 to-purple-900 shadow-lg"
            }, React.createElement("div", {
                className: "max-w-full mx-auto px-4 py-3 flex justify-between items-center"
            }, React.createElement("div", {
                className: "flex items-center gap-4"
            }, React.createElement("div", {
                className: "flex items-center gap-2"
            }, React.createElement("span", {
                className: "text-2xl font-bold text-yellow-400"
            }, "tutts")), React.createElement("h1", {
                className: "text-xl font-bold text-white"
            }, "Acompanhamento Geral")), React.createElement("div", {
                className: "flex items-center gap-2"
            }, React.createElement("button", {
                onClick: () => _a(!0),
                className: "px-4 py-2 bg-white/10 text-white rounded-lg hover:bg-white/20 text-sm font-semibold"
            }, "🔍 Filtros"), React.createElement("button", {
                onClick: () => he("solicitacoes"),
                className: "px-4 py-2 bg-white/10 text-white rounded-lg hover:bg-white/20 text-sm"
            }, "📋 Voltar"), React.createElement("button", {
                onClick: () => o(null),
                className: "px-4 py-2 text-white hover:bg-white/20 rounded-lg"
            }, "Sair")))), React.createElement("div", {
                className: "bg-white border-b px-4 py-2 text-xs text-gray-500"
            }, React.createElement("span", null, "Últ. Leitura: ", (new Date).toLocaleString("pt-BR")), React.createElement("span", {
                className: "ml-4"
            }, "Dados atualizados: ", ua.data_fim ? new Date(ua.data_fim).toLocaleDateString("pt-BR") : "-")), React.createElement("div", {
                className: "bg-white border-b sticky top-0 z-10 shadow-sm"
            }, React.createElement("div", {
                className: "max-w-full mx-auto px-4 flex gap-1 overflow-x-auto"
            }, React.createElement("button", {
                onClick: () => {
                    ht("dashboard"), el()
                },
                className: "px-4 py-3 text-sm font-semibold whitespace-nowrap border-b-2 transition-all " + ("dashboard" === Et ? "border-purple-600 text-purple-600 bg-purple-50" : "border-transparent text-gray-600 hover:text-gray-800")
            }, "📊 Dashboard"), React.createElement("button", {
                onClick: () => {
                    ht("profissionais"), el()
                },
                className: "px-4 py-3 text-sm font-semibold whitespace-nowrap border-b-2 transition-all " + ("profissionais" === Et ? "border-purple-600 text-purple-600 bg-purple-50" : "border-transparent text-gray-600 hover:text-gray-800")
            }, "👤 Por Profissional"), React.createElement("button", {
                onClick: () => {
                    ht("os"), (async () => {
                        try {
                            Ra(!0);
                            const e = Xa(),
                                t = await fetch(`${API_URL}/bi/entregas-lista?${e}`);
                            Ut(await t.json())
                        } catch (e) {
                            console.error("Erro ao carregar entregas:", e)
                        }
                        Ra(!1)
                    })()
                },
                className: "px-4 py-3 text-sm font-semibold whitespace-nowrap border-b-2 transition-all " + ("os" === Et ? "border-purple-600 text-purple-600 bg-purple-50" : "border-transparent text-gray-600 hover:text-gray-800")
            }, "📋 Análise por OS"), React.createElement("button", {
                onClick: () => {
                    ht("upload"), ll()
                },
                className: "px-4 py-3 text-sm font-semibold whitespace-nowrap border-b-2 transition-all " + ("upload" === Et ? "border-purple-600 text-purple-600 bg-purple-50" : "border-transparent text-gray-600 hover:text-gray-800")
            }, "📤 Upload"), React.createElement("button", {
                onClick: () => {
                    ht("config"), tl(), al()
                },
                className: "px-4 py-3 text-sm font-semibold whitespace-nowrap border-b-2 transition-all " + ("config" === Et ? "border-purple-600 text-purple-600 bg-purple-50" : "border-transparent text-gray-600 hover:text-gray-800")
            }, "⚙️ Config"))), wa && React.createElement("div", {
                className: "fixed inset-0 bg-black/50 z-50 flex items-start justify-center pt-10 overflow-hidden"
            }, React.createElement("div", {
                className: "bg-white rounded-xl shadow-2xl w-full max-w-5xl max-h-[85vh] overflow-y-auto"
            }, React.createElement("div", {
                className: "sticky top-0 bg-purple-700 text-white px-6 py-4 flex justify-between items-center z-10"
            }, React.createElement("h2", {
                className: "text-lg font-bold"
            }, "🔍 Filtros Inteligentes"), React.createElement("button", {
                onClick: () => _a(!1),
                className: "text-white hover:bg-white/20 rounded-lg px-3 py-1 text-xl"
            }, "✕")), React.createElement("div", {
                className: "p-6"
            }, React.createElement("div", {
                className: "grid grid-cols-2 md:grid-cols-4 gap-4 mb-4"
            }, React.createElement("div", {
                className: "border rounded-lg p-3 bg-gray-50"
            }, React.createElement("h3", {
                className: "font-semibold text-gray-700 mb-2 text-sm"
            }, "📅 Data Início"), React.createElement("input", {
                type: "date",
                value: ua.data_inicio,
                onChange: e => ga({
                    ...ua,
                    data_inicio: e.target.value
                }),
                className: "w-full px-3 py-2 border rounded text-sm"
            })), React.createElement("div", {
                className: "border rounded-lg p-3 bg-gray-50"
            }, React.createElement("h3", {
                className: "font-semibold text-gray-700 mb-2 text-sm"
            }, "📅 Data Fim"), React.createElement("input", {
                type: "date",
                value: ua.data_fim,
                onChange: e => ga({
                    ...ua,
                    data_fim: e.target.value
                }),
                className: "w-full px-3 py-2 border rounded text-sm"
            })), React.createElement("div", {
                className: "border rounded-lg p-3 bg-gray-50"
            }, React.createElement("h3", {
                className: "font-semibold text-gray-700 mb-2 text-sm"
            }, "⏱️ Status Prazo"), React.createElement("select", {
                value: ua.status_prazo,
                onChange: e => ga({
                    ...ua,
                    status_prazo: e.target.value
                }),
                className: "w-full px-3 py-2 border rounded text-sm"
            }, React.createElement("option", {
                value: ""
            }, "Todos"), React.createElement("option", {
                value: "dentro"
            }, "✅ Dentro do Prazo"), React.createElement("option", {
                value: "fora"
            }, "❌ Fora do Prazo"))), React.createElement("div", {
                className: "border rounded-lg p-3 bg-gray-50"
            }, React.createElement("h3", {
                className: "font-semibold text-gray-700 mb-2 text-sm"
            }, "🗺️ Região"), React.createElement("select", {
                value: ua.regiao || "",
                onChange: e => {
                    const t = e.target.value;
                    let a;
                    if (t) {
                        const e = aa.find(e => e.id === parseInt(t)),
                            l = e?.clientes?.map(e => String(e)) || [];
                        a = {
                            ...ua,
                            regiao: t,
                            cod_cliente: l,
                            centro_custo: [],
                            categoria: ""
                        }
                    } else a = {
                        ...ua,
                        regiao: "",
                        cod_cliente: [],
                        centro_custo: [],
                        categoria: ""
                    };
                    ga(a), rl(a)
                },
                className: "w-full px-3 py-2 border rounded text-sm"
            }, React.createElement("option", {
                value: ""
            }, "Todas as Regiões"), aa.map(e => React.createElement("option", {
                key: e.id,
                value: e.id
            }, e.nome, " (", e.clientes?.length || 0, " clientes)"))))), React.createElement("div", {
                className: "grid grid-cols-1 gap-4 mb-4"
            }, React.createElement("div", {
                className: "border rounded-lg p-3 bg-blue-50"
            }, React.createElement("h3", {
                className: "font-semibold text-gray-700 mb-2 text-sm"
            }, "🏷️ Categoria"), React.createElement("select", {
                value: ua.categoria,
                onChange: e => {
                    const t = {
                        ...ua,
                        categoria: e.target.value
                    };
                    ga(t), rl(t)
                },
                className: "w-full px-3 py-2 border rounded text-sm"
            }, React.createElement("option", {
                value: ""
            }, "Todas as Categorias (", pa.length, " disponíveis)"), pa.map(e => React.createElement("option", {
                key: e,
                value: e
            }, e))))), React.createElement("div", {
                className: "grid grid-cols-1 md:grid-cols-2 gap-4"
            }, React.createElement("div", {
                className: "border rounded-lg p-4 bg-purple-50"
            }, React.createElement("div", {
                className: "flex justify-between items-center mb-3"
            }, React.createElement("h3", {
                className: "font-bold text-purple-800"
            }, "🏢 Cliente (Loja)"), (ua.cod_cliente || []).length > 0 ? React.createElement("button", {
                onClick: () => {
                    const e = {
                        ...ua,
                        cod_cliente: [],
                        centro_custo: [],
                        regiao: ""
                    };
                    ga(e), rl(e)
                },
                className: "text-xs bg-purple-200 text-purple-800 px-2 py-1 rounded-full font-semibold hover:bg-purple-300 cursor-pointer"
            }, (ua.cod_cliente || []).length, " selecionado(s) ✕") : React.createElement("span", {
                className: "text-xs text-purple-600"
            }, "Todas")), React.createElement("select", {
                multiple: !0,
                size: "10",
                value: ua.cod_cliente || [],
                onChange: e => {
                    const t = Array.from(e.target.selectedOptions, e => e.value),
                        a = {
                            ...ua,
                            cod_cliente: t,
                            centro_custo: [],
                            regiao: ""
                        };
                    ga(a), rl(a)
                },
                className: "w-full px-3 py-2 border-2 border-purple-200 rounded-lg text-sm bg-white focus:border-purple-500 focus:ring-2 focus:ring-purple-200"
            }, ia.map(e => React.createElement("option", {
                key: e.cod_cliente,
                value: String(e.cod_cliente),
                className: "py-1"
            }, e.cod_cliente, " - ", il(e.cod_cliente) || e.nome_cliente))), React.createElement("p", {
                className: "text-xs text-purple-600 mt-2"
            }, "💡 Ctrl+Click para multi-seleção | Sem seleção = Todas")), React.createElement("div", {
                className: "border rounded-lg p-4 bg-green-50"
            }, React.createElement("div", {
                className: "flex justify-between items-center mb-3"
            }, React.createElement("h3", {
                className: "font-bold text-green-800"
            }, "📁 Centro de Custo"), (ua.centro_custo || []).length > 0 ? React.createElement("button", {
                onClick: () => {
                    const e = {
                        ...ua,
                        centro_custo: []
                    };
                    ga(e), rl(e)
                },
                className: "text-xs bg-green-200 text-green-800 px-2 py-1 rounded-full font-semibold hover:bg-green-300 cursor-pointer"
            }, (ua.centro_custo || []).length, " selecionado(s) ✕") : React.createElement("span", {
                className: "text-xs text-green-600"
            }, "Todos")), React.createElement("select", {
                multiple: !0,
                size: "10",
                value: ua.centro_custo || [],
                onChange: e => {
                    const t = Array.from(e.target.selectedOptions, e => e.value),
                        a = {
                            ...ua,
                            centro_custo: t
                        };
                    ga(a), rl(a)
                },
                className: "w-full px-3 py-2 border-2 border-green-200 rounded-lg text-sm bg-white focus:border-green-500 focus:ring-2 focus:ring-green-200"
            }, kt.map(e => {
                const t = Object.keys(Tt).find(t => (Tt[t] || []).includes(e.centro_custo));
                return React.createElement("option", {
                    key: e.centro_custo,
                    value: e.centro_custo,
                    className: "py-1"
                }, t || "?", " - ", e.centro_custo)
            })), React.createElement("p", {
                className: "text-xs text-green-600 mt-2"
            }, "💡 Ctrl+Click para multi-seleção | Sem seleção = Todos")))), React.createElement("div", {
                className: "sticky bottom-0 bg-gray-100 px-6 py-4 flex justify-between border-t"
            }, React.createElement("button", {
                onClick: () => {
                    const e = {
                        ...ua,
                        cod_cliente: [],
                        centro_custo: [],
                        categoria: "",
                        status_prazo: "",
                        regiao: ""
                    };
                    ga(e), da(jt), Pt(At), xa(ra)
                },
                className: "px-5 py-2.5 bg-gray-300 text-gray-700 rounded-lg font-semibold hover:bg-gray-400 transition"
            }, "🗑️ Limpar Filtros"), React.createElement("button", {
                onClick: () => {
                    _a(!1), ol(ua)
                },
                className: "px-6 py-2.5 bg-purple-600 text-white rounded-lg font-semibold hover:bg-purple-700 transition shadow-lg"
            }, "🔍 Aplicar Filtros")))), React.createElement("div", {
                className: "max-w-full mx-auto p-4"
            }, ba ? React.createElement("div", {
                className: "text-center py-20"
            }, React.createElement("div", {
                className: "animate-spin text-5xl"
            }, "⏳"), React.createElement("p", {
                className: "text-gray-500 mt-4"
            }, "Carregando dados...")) : React.createElement(React.Fragment, null, "dashboard" === Et && React.createElement(React.Fragment, null, React.createElement("div", {
                className: "grid grid-cols-2 md:grid-cols-5 gap-4 mb-4"
            }, React.createElement("div", {
                className: "bg-purple-700 text-white rounded-lg p-4 text-center"
            }, React.createElement("p", {
                className: "text-xs opacity-80"
            }, "Valor Total"), React.createElement("p", {
                className: "text-2xl font-bold"
            }, sl(ft?.valor_total || 0))), React.createElement("div", {
                className: "bg-purple-600 text-white rounded-lg p-4 text-center"
            }, React.createElement("p", {
                className: "text-xs opacity-80"
            }, "Valor Profissional"), React.createElement("p", {
                className: "text-2xl font-bold"
            }, sl(ft?.valor_prof_total || 0))), React.createElement("div", {
                className: "bg-purple-500 text-white rounded-lg p-4 text-center"
            }, React.createElement("p", {
                className: "text-xs opacity-80"
            }, "Faturamento"), React.createElement("p", {
                className: "text-2xl font-bold"
            }, sl(nl(ft?.valor_total) - nl(ft?.valor_prof_total)))), React.createElement("div", {
                className: "bg-purple-400 text-white rounded-lg p-4 text-center"
            }, React.createElement("p", {
                className: "text-xs opacity-80"
            }, "Ticket Médio"), React.createElement("p", {
                className: "text-2xl font-bold"
            }, sl(ft?.ticket_medio || 0))), React.createElement("div", {
                className: "bg-purple-300 text-purple-900 rounded-lg p-4 text-center"
            }, React.createElement("p", {
                className: "text-xs opacity-80"
            }, "Entrega x Entregadores"), React.createElement("p", {
                className: "text-2xl font-bold"
            }, nl(ft?.media_entregas_por_prof).toFixed(2)))), React.createElement("div", {
                className: "grid grid-cols-2 md:grid-cols-5 gap-4 mb-6"
            }, React.createElement("div", {
                className: "bg-purple-800 text-white rounded-lg p-4 text-center"
            }, React.createElement("p", {
                className: "text-xs opacity-80"
            }, "Quantidade OS"), React.createElement("p", {
                className: "text-3xl font-bold"
            }, nl(ft?.total_os).toLocaleString("pt-BR"))), React.createElement("div", {
                className: "bg-purple-700 text-white rounded-lg p-4 text-center"
            }, React.createElement("p", {
                className: "text-xs opacity-80"
            }, "Quantidade Entregas"), React.createElement("p", {
                className: "text-3xl font-bold"
            }, nl(ft?.total_entregas).toLocaleString("pt-BR")), React.createElement("p", {
                className: "text-xs mt-1"
            }, React.createElement("span", {
                className: "text-green-300"
            }, "No Prazo: ", nl(ft?.dentro_prazo).toLocaleString("pt-BR")), React.createElement("span", {
                className: "mx-2"
            }, "|"), React.createElement("span", {
                className: "text-red-300"
            }, "Fora: ", nl(ft?.fora_prazo).toLocaleString("pt-BR")))), React.createElement("div", {
                className: "bg-purple-600 text-white rounded-lg p-4 text-center"
            }, React.createElement("p", {
                className: "text-xs opacity-80"
            }, "Média Entrega"), React.createElement("p", {
                className: "text-3xl font-bold"
            }, cl(ft?.tempo_medio))), React.createElement("div", {
                className: "bg-purple-500 text-white rounded-lg p-4 text-center"
            }, React.createElement("p", {
                className: "text-xs opacity-80"
            }, "Quantidade Retornos"), React.createElement("p", {
                className: "text-3xl font-bold"
            }, nl(ft?.total_retornos).toLocaleString("pt-BR"))), React.createElement("div", {
                className: "bg-purple-400 text-white rounded-lg p-4 text-center"
            }, React.createElement("p", {
                className: "text-xs opacity-80"
            }, "Entregadores"), React.createElement("p", {
                className: "text-3xl font-bold"
            }, nl(ft?.total_profissionais).toLocaleString("pt-BR")))), React.createElement("div", {
                className: "bg-white rounded-lg shadow overflow-hidden"
            }, React.createElement("div", {
                className: "bg-purple-100 px-4 py-3"
            }, React.createElement("h3", {
                className: "font-bold text-purple-900"
            }, "Resumo Geral por Cliente"), ((ua.cod_cliente || []).length > 0 || (ua.centro_custo || []).length > 0 || ua.categoria || ua.regiao) && React.createElement("div", {
                className: "mt-2 flex flex-wrap gap-2"
            }, ua.regiao && React.createElement("span", {
                className: "text-xs bg-blue-200 text-blue-800 px-2 py-1 rounded-full"
            }, "🗺️ Região: ", aa.find(e => e.id === parseInt(ua.regiao))?.nome || ua.regiao), (ua.cod_cliente || []).length > 0 && !ua.regiao && React.createElement("span", {
                className: "text-xs bg-purple-200 text-purple-800 px-2 py-1 rounded-full"
            }, "🏢 ", (ua.cod_cliente || []).length, " cliente(s)"), (ua.centro_custo || []).length > 0 && React.createElement("span", {
                className: "text-xs bg-green-200 text-green-800 px-2 py-1 rounded-full"
            }, "📁 Centro(s): ", (ua.centro_custo || []).join(", ")), ua.categoria && React.createElement("span", {
                className: "text-xs bg-yellow-200 text-yellow-800 px-2 py-1 rounded-full"
            }, "🏷️ ", ua.categoria))), React.createElement("div", {
                className: "overflow-x-auto"
            }, React.createElement("table", {
                className: "w-full text-sm"
            }, React.createElement("thead", {
                className: "bg-purple-50"
            }, React.createElement("tr", null, React.createElement("th", {
                className: "px-3 py-2 text-left text-purple-900"
            }), React.createElement("th", {
                className: "px-3 py-2 text-left text-purple-900"
            }, "Cliente"), React.createElement("th", {
                className: "px-3 py-2 text-right text-purple-900"
            }, "OS"), React.createElement("th", {
                className: "px-3 py-2 text-right text-purple-900"
            }, "Entregas"), React.createElement("th", {
                className: "px-3 py-2 text-right text-purple-900"
            }, "Retornos"), React.createElement("th", {
                className: "px-3 py-2 text-right text-purple-900"
            }, "No Prazo"), React.createElement("th", {
                className: "px-3 py-2 text-right text-purple-900"
            }, "%"), React.createElement("th", {
                className: "px-3 py-2 text-right text-purple-900"
            }, "Fora"), React.createElement("th", {
                className: "px-3 py-2 text-right text-purple-900"
            }, "%"), React.createElement("th", {
                className: "px-3 py-2 text-right text-purple-900"
            }, "Média"), React.createElement("th", {
                className: "px-3 py-2 text-right text-purple-900"
            }, "Val. Cliente"), React.createElement("th", {
                className: "px-3 py-2 text-right text-purple-900"
            }, "Val. Prof."), React.createElement("th", {
                className: "px-3 py-2 text-right text-purple-900"
            }, "Faturamento"), React.createElement("th", {
                className: "px-3 py-2 text-right text-purple-900"
            }, "Tckt. Médio"), React.createElement("th", {
                className: "px-3 py-2 text-right text-purple-900"
            }, "Entregadores"), React.createElement("th", {
                className: "px-3 py-2 text-right text-purple-900"
            }, "Ent/Entregador"), React.createElement("th", {
                className: "px-3 py-2 text-right text-purple-900"
            }, "Últ. Entrega"))), React.createElement("tbody", null, (zt || []).slice(0, 15).map((e, t) => React.createElement(React.Fragment, {
                key: t
            }, React.createElement("tr", {
                className: "border-b hover:bg-purple-50 " + (t % 2 == 0 ? "bg-white" : "bg-gray-50")
            }, React.createElement("td", {
                className: "px-3 py-2"
            }, React.createElement("button", {
                onClick: () => ml(`dash-cli-${t}`),
                className: "text-purple-600 hover:text-purple-800 font-bold"
            }, Kt[`dash-cli-${t}`] ? "➖" : "➕")), React.createElement("td", {
                className: "px-3 py-2 font-medium"
            }, e.cod_cliente, " - ", e.nome_display || e.nome_cliente), React.createElement("td", {
                className: "px-3 py-2 text-right"
            }, nl(e.total_os).toLocaleString("pt-BR")), React.createElement("td", {
                className: "px-3 py-2 text-right"
            }, nl(e.total_entregas).toLocaleString("pt-BR")), React.createElement("td", {
                className: "px-3 py-2 text-right text-orange-600"
            }, nl(e.total_retornos).toLocaleString("pt-BR")), React.createElement("td", {
                className: "px-3 py-2 text-right text-green-600 font-medium"
            }, nl(e.dentro_prazo).toLocaleString("pt-BR")), React.createElement("td", {
                className: "px-3 py-2 text-right text-green-600"
            }, (nl(e.dentro_prazo) / (nl(e.total_entregas) || 1) * 100).toFixed(2), "%"), React.createElement("td", {
                className: "px-3 py-2 text-right text-red-600 font-medium"
            }, nl(e.fora_prazo).toLocaleString("pt-BR")), React.createElement("td", {
                className: "px-3 py-2 text-right text-red-600"
            }, (nl(e.fora_prazo) / (nl(e.total_entregas) || 1) * 100).toFixed(2), "%"), React.createElement("td", {
                className: "px-3 py-2 text-right"
            }, cl(e.tempo_medio)), React.createElement("td", {
                className: "px-3 py-2 text-right"
            }, sl(e.valor_total)), React.createElement("td", {
                className: "px-3 py-2 text-right"
            }, sl(e.valor_prof)), React.createElement("td", {
                className: "px-3 py-2 text-right font-medium"
            }, sl(nl(e.valor_total) - nl(e.valor_prof))), React.createElement("td", {
                className: "px-3 py-2 text-right"
            }, sl(e.ticket_medio)), React.createElement("td", {
                className: "px-3 py-2 text-right"
            }, nl(e.total_profissionais).toLocaleString("pt-BR")), React.createElement("td", {
                className: "px-3 py-2 text-right"
            }, nl(e.entregas_por_prof).toLocaleString("pt-BR", {
                minimumFractionDigits: 2
            })), React.createElement("td", {
                className: "px-3 py-2 text-right text-xs"
            }, e.ultima_entrega ? React.createElement("span", {
                className: new Date(e.ultima_entrega) > new Date(Date.now() - 6048e5) ? "text-green-600" : "text-orange-500"
            }, "● ", new Date(e.ultima_entrega).toLocaleDateString("pt-BR")) : "-")), Kt[`dash-cli-${t}`] && (e.centros_custo || []).map((a, l) => React.createElement("tr", {
                key: `${t}-cc-${l}`,
                className: "bg-purple-50 border-l-4 border-purple-400"
            }, React.createElement("td", {
                className: "px-3 py-2 text-purple-400 text-center"
            }, "└"), React.createElement("td", {
                className: "px-3 py-2 text-purple-700 pl-6"
            }, "📁 ", e.cod_cliente, " - ", a.centro_custo), React.createElement("td", {
                className: "px-3 py-2 text-right text-purple-600"
            }, nl(a.total_os).toLocaleString("pt-BR")), React.createElement("td", {
                className: "px-3 py-2 text-right text-purple-600"
            }, nl(a.total_entregas).toLocaleString("pt-BR")), React.createElement("td", {
                className: "px-3 py-2 text-right text-orange-500"
            }, nl(a.total_retornos || 0).toLocaleString("pt-BR")), React.createElement("td", {
                className: "px-3 py-2 text-right text-green-600"
            }, nl(a.dentro_prazo).toLocaleString("pt-BR")), React.createElement("td", {
                className: "px-3 py-2 text-right text-green-600"
            }, (nl(a.dentro_prazo) / (nl(a.total_entregas) || 1) * 100).toFixed(2), "%"), React.createElement("td", {
                className: "px-3 py-2 text-right text-red-500"
            }, nl(a.fora_prazo).toLocaleString("pt-BR")), React.createElement("td", {
                className: "px-3 py-2 text-right text-red-500"
            }, (nl(a.fora_prazo) / (nl(a.total_entregas) || 1) * 100).toFixed(2), "%"), React.createElement("td", {
                className: "px-3 py-2 text-right text-purple-600"
            }, cl(a.tempo_medio)), React.createElement("td", {
                className: "px-3 py-2 text-right text-purple-600"
            }, sl(a.valor_total)), React.createElement("td", {
                className: "px-3 py-2 text-right text-purple-600"
            }, sl(a.valor_prof)), React.createElement("td", {
                className: "px-3 py-2 text-right text-purple-600"
            }, sl(nl(a.valor_total) - nl(a.valor_prof))), React.createElement("td", {
                className: "px-3 py-2 text-right text-purple-600"
            }, a.total_entregas > 0 ? sl(nl(a.valor_total) / a.total_entregas) : "-"), React.createElement("td", {
                colSpan: "3",
                className: "px-3 py-2 text-center text-gray-400"
            }, "-")))))), React.createElement("tfoot", {
                className: "bg-purple-200 font-bold"
            }, React.createElement("tr", null, React.createElement("td", {
                className: "px-3 py-2"
            }), React.createElement("td", {
                className: "px-3 py-2"
            }, "Total"), React.createElement("td", {
                className: "px-3 py-2 text-right"
            }, nl(ft?.total_os).toLocaleString("pt-BR")), React.createElement("td", {
                className: "px-3 py-2 text-right"
            }, nl(ft?.total_entregas).toLocaleString("pt-BR")), React.createElement("td", {
                className: "px-3 py-2 text-right text-orange-700"
            }, nl(ft?.total_retornos).toLocaleString("pt-BR")), React.createElement("td", {
                className: "px-3 py-2 text-right text-green-700"
            }, nl(ft?.dentro_prazo).toLocaleString("pt-BR")), React.createElement("td", {
                className: "px-3 py-2 text-right text-green-700"
            }, (nl(ft?.dentro_prazo) / (nl(ft?.total_entregas) || 1) * 100).toFixed(2), "%"), React.createElement("td", {
                className: "px-3 py-2 text-right text-red-700"
            }, nl(ft?.fora_prazo).toLocaleString("pt-BR")), React.createElement("td", {
                className: "px-3 py-2 text-right text-red-700"
            }, (nl(ft?.fora_prazo) / (nl(ft?.total_entregas) || 1) * 100).toFixed(2), "%"), React.createElement("td", {
                className: "px-3 py-2 text-right"
            }, cl(ft?.tempo_medio)), React.createElement("td", {
                className: "px-3 py-2 text-right"
            }, sl(ft?.valor_total)), React.createElement("td", {
                className: "px-3 py-2 text-right"
            }, sl(ft?.valor_prof_total)), React.createElement("td", {
                className: "px-3 py-2 text-right"
            }, sl(nl(ft?.valor_total) - nl(ft?.valor_prof_total))), React.createElement("td", {
                className: "px-3 py-2 text-right"
            }, sl(ft?.ticket_medio)), React.createElement("td", {
                className: "px-3 py-2 text-right"
            }, nl(ft?.total_profissionais).toLocaleString("pt-BR")), React.createElement("td", {
                className: "px-3 py-2 text-right"
            }, nl(ft?.media_entregas_por_prof).toLocaleString("pt-BR", {
                minimumFractionDigits: 2
            })), React.createElement("td", {
                className: "px-3 py-2 text-right"
            }, ft?.ultima_entrega ? new Date(ft.ultima_entrega).toLocaleDateString("pt-BR") : "-")))))), React.createElement("div", {
                className: "space-y-6 mt-6"
            }, React.createElement("div", {
                className: "bg-white rounded-lg shadow p-6"
            }, React.createElement("h3", {
                className: "font-bold text-purple-900 mb-6 text-lg"
            }, "📊 Distribuição de Entregas por Faixas de Tempo"), React.createElement("div", {
                className: "flex items-end gap-4",
                style: {
                    height: "250px"
                }
            }, (() => {
                const e = Qt.porTempo || [],
                    t = Math.max(...e.map(e => e.total || 0), 1),
                    a = e.reduce((e, t) => e + (t.total || 0), 0) || 1;
                return e.map((e, l) => {
                    const r = e.total || 0,
                        o = r / a * 100,
                        c = t > 0 ? r / t * 200 : 0;
                    return React.createElement("div", {
                        key: l,
                        className: "flex-1 flex flex-col items-center justify-end"
                    }, React.createElement("div", {
                        className: "text-sm text-orange-500 font-semibold mb-1"
                    }, o.toFixed(1), "%"), React.createElement("div", {
                        className: "text-lg font-bold text-purple-900 mb-2"
                    }, r.toLocaleString("pt-BR")), React.createElement("div", {
                        className: "w-full bg-purple-600 rounded-t transition-all",
                        style: {
                            height: `${Math.max(c,r>0?20:5)}px`
                        }
                    }), React.createElement("div", {
                        className: "text-xs text-gray-600 mt-3 text-center font-medium"
                    }, e.faixa))
                })
            })())), React.createElement("div", {
                className: "bg-white rounded-lg shadow p-6"
            }, React.createElement("h3", {
                className: "font-bold text-purple-900 mb-6 text-lg"
            }, "📊 Entregas por Faixas de Km"), React.createElement("div", {
                className: "flex gap-6"
            }, React.createElement("div", {
                className: "flex-1"
            }, React.createElement("div", {
                className: "flex items-end gap-2",
                style: {
                    height: "250px"
                }
            }, (() => {
                const e = (Qt.porKm || []).filter(e => !Gt?.includes(e.faixa)),
                    t = Math.max(...e.map(e => e.total || 0), 1),
                    a = e.reduce((e, t) => e + (t.total || 0), 0) || 1;
                return e.map((e, l) => {
                    const r = e.total || 0,
                        o = r / a * 100,
                        c = t > 0 ? r / t * 200 : 0;
                    return React.createElement("div", {
                        key: l,
                        className: "flex-1 min-w-[35px] flex flex-col items-center justify-end"
                    }, React.createElement("div", {
                        className: "text-xs text-orange-500 font-semibold mb-1"
                    }, o.toFixed(1), "%"), React.createElement("div", {
                        className: "text-sm font-bold text-purple-900 mb-2"
                    }, r.toLocaleString("pt-BR")), React.createElement("div", {
                        className: "w-full bg-purple-600 rounded-t transition-all max-w-[30px]",
                        style: {
                            height: `${Math.max(c,r>0?15:3)}px`
                        }
                    }), React.createElement("div", {
                        className: "text-[10px] text-gray-600 mt-2 text-center font-medium"
                    }, e.faixa))
                })
            })())), React.createElement("div", {
                className: "w-40 flex-shrink-0 border-l pl-4"
            }, React.createElement("div", {
                className: "text-sm font-bold text-gray-700 mb-3"
            }, "Faixa KM"), React.createElement("div", {
                className: "space-y-1 max-h-64 overflow-y-auto"
            }, (Qt.porKm || []).map((e, t) => React.createElement("label", {
                key: t,
                className: "flex items-center gap-2 cursor-pointer hover:bg-purple-50 px-2 py-1 rounded transition-colors"
            }, React.createElement("input", {
                type: "checkbox",
                checked: !Gt?.includes(e.faixa),
                onChange: t => {
                    t.target.checked ? Wt(t => (t || []).filter(t => t !== e.faixa)) : Wt(t => [...t || [], e.faixa])
                },
                className: "w-4 h-4 accent-purple-600 rounded"
            }), React.createElement("span", {
                className: "text-sm text-gray-700"
            }, e.faixa, " KM"), e.total > 0 && React.createElement("span", {
                className: "text-orange-500"
            }, "🔥"))))))))), "profissionais" === Et && React.createElement("div", {
                className: "bg-white rounded-lg shadow overflow-hidden"
            }, React.createElement("div", {
                className: "bg-purple-100 px-4 py-3"
            }, React.createElement("h3", {
                className: "font-bold text-purple-900"
            }, "Análise por Profissional")), React.createElement("div", {
                className: "overflow-x-auto"
            }, React.createElement("table", {
                className: "w-full text-sm"
            }, React.createElement("thead", {
                className: "bg-purple-50"
            }, React.createElement("tr", null, React.createElement("th", {
                className: "px-3 py-2 text-left text-purple-900"
            }), React.createElement("th", {
                className: "px-3 py-2 text-left text-purple-900"
            }, "Nome prof."), React.createElement("th", {
                className: "px-3 py-2 text-right text-purple-900"
            }, "Entregas"), React.createElement("th", {
                className: "px-3 py-2 text-right text-purple-900"
            }, "Médio Alocado"), React.createElement("th", {
                className: "px-3 py-2 text-right text-purple-900"
            }, "Médio Coleta"), React.createElement("th", {
                className: "px-3 py-2 text-right text-purple-900"
            }, "Médio Entrega"), React.createElement("th", {
                className: "px-3 py-2 text-right text-purple-900"
            }, "No Prazo"), React.createElement("th", {
                className: "px-3 py-2 text-right text-purple-900"
            }, "No Prazo %"), React.createElement("th", {
                className: "px-3 py-2 text-right text-purple-900"
            }, "Fora Prazo"), React.createElement("th", {
                className: "px-3 py-2 text-right text-purple-900"
            }, "Fora %"), React.createElement("th", {
                className: "px-3 py-2 text-right text-purple-900"
            }, "Distância"), React.createElement("th", {
                className: "px-3 py-2 text-right text-purple-900"
            }, "Retorno"), React.createElement("th", {
                className: "px-3 py-2 text-right text-purple-900"
            }, "Val. Prof."))), React.createElement("tbody", null, Vt.map((e, t) => React.createElement(React.Fragment, {
                key: t
            }, React.createElement("tr", {
                className: "border-b hover:bg-purple-50 " + (t % 2 == 0 ? "bg-white" : "bg-gray-50")
            }, React.createElement("td", {
                className: "px-3 py-2"
            }, React.createElement("button", {
                onClick: () => ml(`prof-${t}`),
                className: "text-purple-600 hover:text-purple-800 font-bold"
            }, Kt[`prof-${t}`] ? "➖" : "➕")), React.createElement("td", {
                className: "px-3 py-2 font-medium"
            }, e.cod_prof, " - ", e.nome_prof), React.createElement("td", {
                className: "px-3 py-2 text-right"
            }, nl(e.total_entregas).toLocaleString("pt-BR")), React.createElement("td", {
                className: "px-3 py-2 text-right"
            }, cl(e.tempo_alocado)), React.createElement("td", {
                className: "px-3 py-2 text-right"
            }, cl(e.tempo_coleta)), React.createElement("td", {
                className: "px-3 py-2 text-right"
            }, cl(e.tempo_medio)), React.createElement("td", {
                className: "px-3 py-2 text-right text-green-600 font-medium"
            }, nl(e.dentro_prazo).toLocaleString("pt-BR")), React.createElement("td", {
                className: "px-3 py-2 text-right text-green-600"
            }, (nl(e.dentro_prazo) / (nl(e.total_entregas) || 1) * 100).toFixed(2), "%"), React.createElement("td", {
                className: "px-3 py-2 text-right text-red-600 font-medium"
            }, nl(e.fora_prazo).toLocaleString("pt-BR")), React.createElement("td", {
                className: "px-3 py-2 text-right text-red-600"
            }, (nl(e.fora_prazo) / (nl(e.total_entregas) || 1) * 100).toFixed(2), "%"), React.createElement("td", {
                className: "px-3 py-2 text-right"
            }, parseFloat(e.distancia_total || 0).toLocaleString("pt-BR", {
                maximumFractionDigits: 2
            }), " km"), React.createElement("td", {
                className: "px-3 py-2 text-right"
            }, e.retornos || 0), React.createElement("td", {
                className: "px-3 py-2 text-right"
            }, sl(e.valor_prof))), Kt[`prof-${t}`] && React.createElement("tr", {
                className: "bg-blue-100"
            }, React.createElement("td", {
                colSpan: "13",
                className: "px-6 py-3"
            }, React.createElement("div", {
                className: "text-sm grid grid-cols-2 md:grid-cols-4 gap-4"
            }, React.createElement("div", null, React.createElement("span", {
                className: "font-semibold text-blue-800"
            }, "📊 Média por Entrega: "), React.createElement("span", {
                className: "text-blue-700"
            }, cl(e.tempo_medio))), React.createElement("div", null, React.createElement("span", {
                className: "font-semibold text-blue-800"
            }, "📍 Distância Total: "), React.createElement("span", {
                className: "text-blue-700"
            }, parseFloat(e.distancia_total || 0).toLocaleString("pt-BR", {
                maximumFractionDigits: 2
            }), " km")), React.createElement("div", null, React.createElement("span", {
                className: "font-semibold text-blue-800"
            }, "✅ Taxa de Acerto: "), React.createElement("span", {
                className: "text-green-700 font-bold"
            }, (nl(e.dentro_prazo) / (nl(e.total_entregas) || 1) * 100).toFixed(1), "%")), React.createElement("div", null, React.createElement("span", {
                className: "font-semibold text-blue-800"
            }, "💰 Valor Total: "), React.createElement("span", {
                className: "text-blue-700"
            }, sl(e.valor_prof))))))))), React.createElement("tfoot", {
                className: "bg-purple-200 font-bold"
            }, React.createElement("tr", null, React.createElement("td", {
                className: "px-3 py-2"
            }), React.createElement("td", {
                className: "px-3 py-2"
            }, "Total"), React.createElement("td", {
                className: "px-3 py-2 text-right"
            }, Vt.reduce((e, t) => e + nl(t.total_entregas), 0).toLocaleString("pt-BR")), React.createElement("td", {
                className: "px-3 py-2 text-right"
            }, "-"), React.createElement("td", {
                className: "px-3 py-2 text-right"
            }, "-"), React.createElement("td", {
                className: "px-3 py-2 text-right"
            }, "-"), React.createElement("td", {
                className: "px-3 py-2 text-right text-green-700"
            }, Vt.reduce((e, t) => e + nl(t.dentro_prazo), 0).toLocaleString("pt-BR")), React.createElement("td", {
                className: "px-3 py-2 text-right"
            }, "-"), React.createElement("td", {
                className: "px-3 py-2 text-right text-red-700"
            }, Vt.reduce((e, t) => e + nl(t.fora_prazo), 0).toLocaleString("pt-BR")), React.createElement("td", {
                className: "px-3 py-2 text-right"
            }, "-"), React.createElement("td", {
                className: "px-3 py-2 text-right"
            }, Vt.reduce((e, t) => e + parseFloat(t.distancia_total || 0), 0).toLocaleString("pt-BR", {
                maximumFractionDigits: 2
            }), " km"), React.createElement("td", {
                className: "px-3 py-2 text-right"
            }, Vt.reduce((e, t) => e + nl(t.retornos), 0)), React.createElement("td", {
                className: "px-3 py-2 text-right"
            }, sl(Vt.reduce((e, t) => e + nl(t.valor_prof), 0)))))))), "os" === Et && React.createElement("div", {
                className: "bg-white rounded-lg shadow overflow-hidden"
            }, React.createElement("div", {
                className: "bg-purple-100 px-4 py-3"
            }, React.createElement("h3", {
                className: "font-bold text-purple-900"
            }, "Análise por OS")), React.createElement("div", {
                className: "overflow-x-auto"
            }, React.createElement("table", {
                className: "w-full text-sm"
            }, React.createElement("thead", {
                className: "bg-purple-50"
            }, React.createElement("tr", null, React.createElement("th", {
                className: "px-3 py-2 text-left text-purple-900"
            }, "OS"), React.createElement("th", {
                className: "px-3 py-2 text-left text-purple-900"
            }, "Entregador"), React.createElement("th", {
                className: "px-3 py-2 text-left text-purple-900"
            }, "Ponto"), React.createElement("th", {
                className: "px-3 py-2 text-left text-purple-900"
            }, "Endereço"), React.createElement("th", {
                className: "px-3 py-2 text-center text-purple-900"
            }, "Data"), React.createElement("th", {
                className: "px-3 py-2 text-center text-purple-900"
            }, "Solicitado"), React.createElement("th", {
                className: "px-3 py-2 text-center text-purple-900"
            }, "Chegada"), React.createElement("th", {
                className: "px-3 py-2 text-center text-purple-900"
            }, "Saída"), React.createElement("th", {
                className: "px-3 py-2 text-center text-purple-900"
            }, "Duração"), React.createElement("th", {
                className: "px-3 py-2 text-right text-purple-900"
            }, "Distância"), React.createElement("th", {
                className: "px-3 py-2 text-center text-purple-900"
            }, "Status"), React.createElement("th", {
                className: "px-3 py-2 text-center text-purple-900"
            }, "Finalização"))), React.createElement("tbody", null, qt.slice(0, 100).map((e, t) => React.createElement("tr", {
                key: t,
                className: "border-b hover:bg-purple-50 " + (t % 2 == 0 ? "bg-white" : "bg-gray-50")
            }, React.createElement("td", {
                className: "px-3 py-2 font-medium"
            }, e.os), React.createElement("td", {
                className: "px-3 py-2"
            }, e.nome_prof), React.createElement("td", {
                className: "px-3 py-2"
            }, React.createElement("span", {
                className: "px-2 py-0.5 rounded text-xs " + ("Coleta" === e.ponto ? "bg-blue-100 text-blue-700" : "bg-green-100 text-green-700")
            }, e.ponto || "Entrega")), React.createElement("td", {
                className: "px-3 py-2 max-w-xs truncate",
                title: e.endereco
            }, e.endereco), React.createElement("td", {
                className: "px-3 py-2 text-center"
            }, e.data_solicitado ? new Date(e.data_solicitado).toLocaleDateString("pt-BR") : "-"), React.createElement("td", {
                className: "px-3 py-2 text-center"
            }, e.hora_solicitado || "-"), React.createElement("td", {
                className: "px-3 py-2 text-center"
            }, e.hora_chegada || "-"), React.createElement("td", {
                className: "px-3 py-2 text-center"
            }, e.hora_saida || "-"), React.createElement("td", {
                className: "px-3 py-2 text-center"
            }, cl(e.tempo_execucao_minutos)), React.createElement("td", {
                className: "px-3 py-2 text-right"
            }, parseFloat(e.distancia || 0).toFixed(2), " km"), React.createElement("td", {
                className: "px-3 py-2 text-center"
            }, !0 === e.dentro_prazo && React.createElement("span", {
                className: "text-green-600"
            }, "✅"), !1 === e.dentro_prazo && React.createElement("span", {
                className: "text-red-600"
            }, "❌"), null === e.dentro_prazo && React.createElement("span", {
                className: "text-gray-400"
            }, "-")), React.createElement("td", {
                className: "px-3 py-2 text-center"
            }, e.finalizado ? new Date(e.finalizado).toLocaleDateString("pt-BR") : "-")))))), qt.length > 100 && React.createElement("div", {
                className: "bg-gray-50 px-4 py-3 text-center text-sm text-gray-500"
            }, "Mostrando 100 de ", qt.length, " registros. Use os filtros para refinar a busca.")), "upload" === Et && React.createElement("div", {
                className: "space-y-6"
            }, React.createElement("div", {
                className: "bg-white rounded-xl shadow p-6"
            }, React.createElement("h2", {
                className: "text-xl font-bold text-purple-900 mb-6"
            }, "📤 Upload de Planilha"), React.createElement("div", {
                className: "border-2 border-dashed border-purple-300 rounded-xl p-10 text-center bg-purple-50"
            }, Ea ? React.createElement("div", null, React.createElement("div", {
                className: "animate-spin text-5xl mb-4"
            }, "⏳"), React.createElement("p", {
                className: "text-purple-600"
            }, Ea)) : React.createElement(React.Fragment, null, React.createElement("p", {
                className: "text-5xl mb-4"
            }, "📄"), React.createElement("p", {
                className: "text-purple-600 mb-4"
            }, "Selecione uma planilha Excel (.xlsx)"), React.createElement("input", {
                type: "file",
                accept: ".xlsx,.xls",
                onChange: e => {
                    e.target.files[0] && ((async e => {
                        try {
                            ha("Lendo arquivo...");
                            const t = await e.arrayBuffer(),
                                a = XLSX.read(t, {
                                    type: "array"
                                }),
                                l = a.Sheets[a.SheetNames[0]],
                                r = XLSX.utils.sheet_to_json(l);
                            ha(`Processando ${r.length} linhas...`);
                            const o = r.map(e => ({
                                os: e.OS,
                                num_pedido: e["Nº Pedido"],
                                cod_cliente: e["Cód. cliente"],
                                nome_cliente: e["Nome cliente"],
                                empresa: e.Empresa,
                                nome_fantasia: e["Nome fantasia"],
                                centro_custo: e["Centro custo"],
                                cidade_p1: e["Cidade P1"],
                                endereco: e["Endereço"],
                                bairro: e.Bairro,
                                cidade: e.Cidade,
                                estado: e.Estado,
                                cod_prof: e["Cód. prof."],
                                nome_prof: e["Nome prof."],
                                data_hora: e["Data/Hora"],
                                data_hora_alocado: e["Data/Hora Alocado"],
                                data_solicitado: e["Data solicitado"],
                                hora_solicitado: e["Hora solicitado"],
                                data_chegada: e["Data Chegada"],
                                hora_chegada: e["Hora Chegada"],
                                data_saida: e["Data Saida"],
                                hora_saida: e["Hora Saida"],
                                categoria: e.Categoria,
                                valor: e.Valor,
                                distancia: e["Distância"],
                                valor_prof: e["Valor prof."],
                                finalizado: e.Finalizado,
                                execucao_comp: e["Execução Comp."],
                                execucao_espera: e["Execução - Espera"],
                                status: e.Status,
                                motivo: e.Motivo,
                                ocorrencia: e["Ocorrência"],
                                velocidade_media: e["Velocidade Média"]
                            })).filter(e => e.os);
                            console.log("📋 Primeira entrega:", o[0]), console.log("📋 Centro custo:", o[0]?.centro_custo), console.log("📋 Colunas do Excel:", Object.keys(r[0] || {})), ha(`Enviando ${o.length} entregas...`);
                            const c = await fetch(`${API_URL}/bi/entregas/upload`, {
                                    method: "POST",
                                    headers: {
                                        "Content-Type": "application/json"
                                    },
                                    body: JSON.stringify({
                                        entregas: o
                                    })
                                }),
                                s = await c.json();
                            s.success ? (ja(`✅ Upload concluído! ${s.inseridos} novos, ${s.atualizados} atualizados`, "success"), el(), ll()) : ja("❌ Erro no upload: " + s.error, "error")
                        } catch (e) {
                            console.error("Erro no upload:", e), ja("❌ Erro ao processar arquivo: " + e.message, "error")
                        }
                        ha(null)
                    })(e.target.files[0]), e.target.value = "")
                },
                className: "hidden",
                id: "bi-upload-file"
            }), React.createElement("label", {
                htmlFor: "bi-upload-file",
                className: "px-6 py-3 bg-purple-600 text-white rounded-lg font-semibold cursor-pointer hover:bg-purple-700 inline-block"
            }, "📤 Selecionar Arquivo")))), React.createElement("div", {
                className: "bg-white rounded-xl shadow p-6"
            }, React.createElement("h2", {
                className: "text-xl font-bold text-purple-900 mb-4"
            }, "📋 Histórico de Uploads"), 0 === Mt.length ? React.createElement("p", {
                className: "text-gray-500 text-center py-8"
            }, "Nenhum upload realizado ainda") : React.createElement("div", {
                className: "space-y-3"
            }, Mt.map((e, t) => React.createElement("div", {
                key: t,
                className: "flex items-center justify-between p-4 bg-purple-50 rounded-lg border border-purple-200"
            }, React.createElement("div", null, React.createElement("p", {
                className: "font-semibold text-purple-900"
            }, "📅 Upload de ", new Date(e.data_upload).toLocaleDateString("pt-BR")), React.createElement("p", {
                className: "text-sm text-purple-600"
            }, e.total_registros, " registros • Período: ", e.data_inicial ? new Date(e.data_inicial).toLocaleDateString("pt-BR") : "-", " a ", e.data_final ? new Date(e.data_final).toLocaleDateString("pt-BR") : "-")), React.createElement("button", {
                onClick: () => (async e => {
                    if (confirm(`Excluir todos os registros do upload de ${new Date(e).toLocaleDateString("pt-BR")}?`)) try {
                        const t = await fetch(`${API_URL}/bi/uploads/${e}`, {
                                method: "DELETE"
                            }),
                            a = await t.json();
                        ja(`✅ ${a.deletados} registros excluídos!`, "success"), ll(), el()
                    } catch (e) {
                        ja("Erro ao excluir", "error")
                    }
                })(e.data_upload),
                className: "px-4 py-2 bg-red-100 text-red-600 rounded-lg hover:bg-red-200 font-semibold text-sm"
            }, "🗑️ Excluir"))))), React.createElement("div", {
                className: "bg-blue-50 border border-blue-200 rounded-xl p-4"
            }, React.createElement("div", {
                className: "flex items-center justify-between"
            }, React.createElement("div", null, React.createElement("h4", {
                className: "font-semibold text-blue-800"
            }, "🔄 Recalcular Prazos"), React.createElement("p", {
                className: "text-sm text-blue-600"
            }, "Após alterar configurações de prazo, recalcule para atualizar os dados")), React.createElement("button", {
                onClick: xl,
                disabled: ba,
                className: "px-4 py-2 bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700 disabled:opacity-50"
            }, ba ? "⏳ Recalculando..." : "🔄 Recalcular")))), "config" === Et && React.createElement("div", {
                className: "space-y-6"
            }, React.createElement("div", {
                className: "bg-white rounded-xl shadow p-6"
            }, React.createElement("h2", {
                className: "text-xl font-bold text-purple-900 mb-2"
            }, "🗺️ Configuração de Regiões"), React.createElement("p", {
                className: "text-sm text-gray-500 mb-4"
            }, "Agrupe clientes em regiões para facilitar a filtragem no dashboard."), React.createElement("div", {
                className: "border rounded-lg p-4 mb-4 bg-gray-50"
            }, React.createElement("div", {
                className: "grid grid-cols-1 md:grid-cols-2 gap-4 mb-4"
            }, React.createElement("div", null, React.createElement("label", {
                className: "text-sm font-semibold text-gray-700"
            }, "Nome da Região"), React.createElement("input", {
                type: "text",
                id: "bi-regiao-nome",
                placeholder: "Ex: Grande Recife, Interior, Zona Sul...",
                className: "w-full px-3 py-2 border rounded-lg mt-1"
            })), React.createElement("div", null, React.createElement("label", {
                className: "text-sm font-semibold text-gray-700"
            }, "Clientes da Região"), React.createElement("select", {
                id: "bi-regiao-clientes",
                multiple: !0,
                size: "5",
                className: "w-full px-2 py-1 border rounded-lg mt-1 text-sm"
            }, jt.map(e => React.createElement("option", {
                key: e.cod_cliente,
                value: e.cod_cliente
            }, e.cod_cliente, " - ", il(e.cod_cliente) || e.nome_cliente))), React.createElement("p", {
                className: "text-xs text-gray-400 mt-1"
            }, "Ctrl+Click para selecionar múltiplos"))), React.createElement("button", {
                onClick: () => {
                    const e = document.getElementById("bi-regiao-nome").value.trim(),
                        t = document.getElementById("bi-regiao-clientes"),
                        a = Array.from(t.selectedOptions, e => parseInt(e.value));
                    return e ? 0 === a.length ? ja("Selecione pelo menos um cliente", "error") : ((async (e, t) => {
                        try {
                            const a = await fetch(`${API_URL}/bi/regioes`, {
                                    method: "POST",
                                    headers: {
                                        "Content-Type": "application/json"
                                    },
                                    body: JSON.stringify({
                                        nome: e,
                                        clientes: t
                                    })
                                }),
                                l = await a.json();
                            l.success ? (ja("✅ Região salva!", "success"), pl()) : ja("❌ Erro: " + l.error, "error")
                        } catch (e) {
                            ja("Erro ao salvar região", "error")
                        }
                    })(e, a), document.getElementById("bi-regiao-nome").value = "", void(t.selectedIndex = -1)) : ja("Digite o nome da região", "error")
                },
                className: "px-4 py-2 bg-green-600 text-white rounded-lg font-semibold hover:bg-green-700"
            }, "➕ Criar Região")), 0 === aa.length ? React.createElement("p", {
                className: "text-gray-500 text-center py-4 bg-gray-50 rounded-lg"
            }, "Nenhuma região configurada") : React.createElement("div", {
                className: "space-y-3"
            }, aa.map(e => React.createElement("div", {
                key: e.id,
                className: "border border-blue-200 rounded-lg p-4 bg-blue-50"
            }, React.createElement("div", {
                className: "flex justify-between items-start mb-2"
            }, React.createElement("div", null, React.createElement("h3", {
                className: "font-bold text-blue-900"
            }, e.nome), React.createElement("p", {
                className: "text-sm text-blue-600"
            }, e.clientes?.length || 0, " clientes")), React.createElement("button", {
                onClick: () => (async e => {
                    if (confirm("Excluir esta região?")) try {
                        (await fetch(`${API_URL}/bi/regioes/${e}`, {
                            method: "DELETE"
                        })).ok && (ja("✅ Região excluída!", "success"), pl())
                    } catch (e) {
                        ja("Erro ao excluir", "error")
                    }
                })(e.id),
                className: "text-red-500 hover:text-red-700 p-1"
            }, "🗑️")), React.createElement("div", {
                className: "flex flex-wrap gap-1"
            }, (e.clientes || []).map(e => {
                const t = jt.find(t => t.cod_cliente === e);
                return React.createElement("span", {
                    key: e,
                    className: "text-xs bg-white border border-blue-300 px-2 py-0.5 rounded"
                }, e, " - ", il(e) || t?.nome_cliente || "")
            })))))), React.createElement("div", {
                className: "bg-white rounded-xl shadow p-6"
            }, React.createElement("h2", {
                className: "text-xl font-bold text-purple-900 mb-2"
            }, "🏷️ Máscaras de Clientes"), React.createElement("p", {
                className: "text-sm text-gray-500 mb-4"
            }, "Defina apelidos para os códigos de clientes. Esses apelidos aparecerão nos filtros e visualizações."), React.createElement("div", {
                className: "flex gap-3 mb-4 flex-wrap"
            }, React.createElement("select", {
                id: "bi-mascara-cliente",
                className: "flex-1 min-w-48 px-3 py-2 border rounded-lg"
            }, React.createElement("option", {
                value: ""
            }, "-- Selecione um Cliente --"), jt.map(e => React.createElement("option", {
                key: e.cod_cliente,
                value: `${e.cod_cliente}:${e.nome_cliente}`
            }, e.cod_cliente, " - ", e.nome_cliente))), React.createElement("input", {
                type: "text",
                id: "bi-mascara-nome",
                placeholder: "Digite a máscara (apelido)",
                className: "flex-1 min-w-48 px-3 py-2 border rounded-lg"
            }), React.createElement("button", {
                onClick: () => {
                    const e = document.getElementById("bi-mascara-cliente").value,
                        t = document.getElementById("bi-mascara-nome").value.trim();
                    if (!e || !t) return ja("Selecione um cliente e digite a máscara", "error");
                    const [a] = e.split(":");
                    (async (e, t) => {
                        try {
                            const a = await fetch(`${API_URL}/bi/mascaras`, {
                                    method: "POST",
                                    headers: {
                                        "Content-Type": "application/json"
                                    },
                                    body: JSON.stringify({
                                        cod_cliente: e,
                                        mascara: t
                                    })
                                }),
                                l = await a.json();
                            l.success ? (ja("✅ Máscara salva!", "success"), dl()) : ja("❌ Erro: " + l.error, "error")
                        } catch (e) {
                            ja("Erro ao salvar máscara", "error")
                        }
                    })(a, t), document.getElementById("bi-mascara-cliente").value = "", document.getElementById("bi-mascara-nome").value = ""
                },
                className: "px-4 py-2 bg-purple-600 text-white rounded-lg font-semibold hover:bg-purple-700 whitespace-nowrap"
            }, "💾 Salvar Máscara")), 0 === ea.length ? React.createElement("p", {
                className: "text-gray-500 text-center py-4 bg-gray-50 rounded-lg"
            }, "Nenhuma máscara configurada") : React.createElement("div", {
                className: "space-y-2"
            }, ea.map(e => React.createElement("div", {
                key: e.id,
                className: "flex items-center justify-between p-3 bg-purple-50 rounded-lg border border-purple-200"
            }, React.createElement("div", null, React.createElement("span", {
                className: "font-mono bg-purple-200 px-2 py-0.5 rounded text-purple-900"
            }, e.cod_cliente), React.createElement("span", {
                className: "mx-2"
            }, "→"), React.createElement("span", {
                className: "font-semibold text-purple-900"
            }, e.mascara)), React.createElement("button", {
                onClick: () => (async e => {
                    if (confirm("Excluir esta máscara?")) try {
                        (await fetch(`${API_URL}/bi/mascaras/${e}`, {
                            method: "DELETE"
                        })).ok && (ja("✅ Máscara excluída!", "success"), dl())
                    } catch (e) {
                        ja("Erro ao excluir", "error")
                    }
                })(e.id),
                className: "text-red-500 hover:text-red-700 p-1"
            }, "🗑️"))))), React.createElement("div", {
                className: "bg-white rounded-xl shadow p-6"
            }, React.createElement("h2", {
                className: "text-xl font-bold text-purple-900 mb-2"
            }, "⚙️ Prazo Padrão"), React.createElement("p", {
                className: "text-sm text-gray-500 mb-4"
            }, "Usado para clientes/centros sem configuração específica"), React.createElement("div", {
                className: "space-y-3 mb-4"
            }, fa.map((e, t) => React.createElement("div", {
                key: t,
                className: "flex items-center gap-2 p-3 bg-purple-50 rounded-lg flex-wrap"
            }, React.createElement("span", {
                className: "text-sm font-medium"
            }, "De"), React.createElement("input", {
                type: "number",
                value: e.km_min,
                onChange: e => {
                    const a = [...fa];
                    a[t].km_min = Number(e.target.value), Na(a)
                },
                className: "w-20 px-2 py-1 border rounded text-center",
                min: "0"
            }), React.createElement("span", {
                className: "text-sm font-medium"
            }, "até"), React.createElement("input", {
                type: "number",
                value: e.km_max || "",
                onChange: e => {
                    const a = [...fa];
                    a[t].km_max = e.target.value ? Number(e.target.value) : null, Na(a)
                },
                placeholder: "∞",
                className: "w-20 px-2 py-1 border rounded text-center",
                min: "0"
            }), React.createElement("span", {
                className: "text-sm font-medium"
            }, "km →"), React.createElement("input", {
                type: "number",
                value: e.prazo_minutos,
                onChange: e => {
                    const a = [...fa];
                    a[t].prazo_minutos = Number(e.target.value), Na(a)
                },
                className: "w-20 px-2 py-1 border rounded text-center",
                min: "1"
            }), React.createElement("span", {
                className: "text-sm font-medium"
            }, "minutos"), fa.length > 1 && React.createElement("button", {
                onClick: () => Na(fa.filter((e, a) => a !== t)),
                className: "text-red-500 hover:text-red-700 ml-2"
            }, "🗑️")))), React.createElement("div", {
                className: "flex gap-3"
            }, React.createElement("button", {
                onClick: () => {
                    const e = fa[fa.length - 1];
                    Na([...fa, {
                        km_min: e.km_max || 0,
                        km_max: null,
                        prazo_minutos: 60
                    }])
                },
                className: "px-4 py-2 bg-gray-200 text-gray-700 rounded-lg font-semibold hover:bg-gray-300"
            }, "➕ Adicionar Faixa"), React.createElement("button", {
                onClick: () => (async e => {
                    try {
                        const t = await fetch(`${API_URL}/bi/prazo-padrao`, {
                                method: "POST",
                                headers: {
                                    "Content-Type": "application/json"
                                },
                                body: JSON.stringify({
                                    faixas: e
                                })
                            }),
                            a = await t.json();
                        a.success ? (ja("✅ Prazo padrão salvo!", "success"), al(), xl()) : ja("❌ Erro: " + a.error, "error")
                    } catch (e) {
                        ja("Erro ao salvar", "error")
                    }
                })(fa),
                className: "px-4 py-2 bg-purple-600 text-white rounded-lg font-semibold hover:bg-purple-700"
            }, "💾 Salvar Prazo Padrão"))), React.createElement("div", {
                className: "bg-white rounded-xl shadow p-6"
            }, React.createElement("h2", {
                className: "text-xl font-bold text-purple-900 mb-2"
            }, "➕ Prazo por Cliente ou Centro de Custo"), React.createElement("p", {
                className: "text-sm text-gray-500 mb-4"
            }, "Configure prazos específicos que sobrescrevem o padrão"), React.createElement("div", {
                className: "mb-4"
            }, React.createElement("label", {
                className: "text-sm text-gray-600 font-medium"
            }, "Selecionar Cliente ou Centro de Custo"), React.createElement("select", {
                id: "bi-novo-codigo",
                className: "w-full px-3 py-2 border rounded-lg mt-1"
            }, React.createElement("option", {
                value: ""
            }, "-- Selecione --"), React.createElement("optgroup", {
                label: "👤 Clientes"
            }, jt.map(e => React.createElement("option", {
                key: `cli-${e.cod_cliente}`,
                value: `cliente:${e.cod_cliente}:${il(e.cod_cliente)||e.nome_cliente}`
            }, il(e.cod_cliente) || e.nome_cliente, " (Cód: ", e.cod_cliente, ")"))), React.createElement("optgroup", {
                label: "🏢 Centros de Custo"
            }, At.map(e => React.createElement("option", {
                key: `cc-${e.centro_custo}`,
                value: `centro_custo:${e.centro_custo}:${e.centro_custo}`
            }, e.centro_custo))))), React.createElement("div", {
                className: "space-y-3 mb-4"
            }, ya.map((e, t) => React.createElement("div", {
                key: t,
                className: "flex items-center gap-2 p-3 bg-gray-50 rounded-lg flex-wrap"
            }, React.createElement("span", {
                className: "text-sm font-medium"
            }, "De"), React.createElement("input", {
                type: "number",
                value: e.km_min,
                onChange: e => {
                    const a = [...ya];
                    a[t].km_min = Number(e.target.value), va(a)
                },
                className: "w-20 px-2 py-1 border rounded text-center",
                min: "0"
            }), React.createElement("span", {
                className: "text-sm font-medium"
            }, "até"), React.createElement("input", {
                type: "number",
                value: e.km_max || "",
                onChange: e => {
                    const a = [...ya];
                    a[t].km_max = e.target.value ? Number(e.target.value) : null, va(a)
                },
                placeholder: "∞",
                className: "w-20 px-2 py-1 border rounded text-center",
                min: "0"
            }), React.createElement("span", {
                className: "text-sm font-medium"
            }, "km →"), React.createElement("input", {
                type: "number",
                value: e.prazo_minutos,
                onChange: e => {
                    const a = [...ya];
                    a[t].prazo_minutos = Number(e.target.value), va(a)
                },
                className: "w-20 px-2 py-1 border rounded text-center",
                min: "1"
            }), React.createElement("span", {
                className: "text-sm font-medium"
            }, "minutos"), ya.length > 1 && React.createElement("button", {
                onClick: () => va(ya.filter((e, a) => a !== t)),
                className: "text-red-500 hover:text-red-700 ml-2"
            }, "🗑️")))), React.createElement("div", {
                className: "flex gap-3"
            }, React.createElement("button", {
                onClick: () => {
                    const e = ya[ya.length - 1];
                    va([...ya, {
                        km_min: e.km_max || 0,
                        km_max: null,
                        prazo_minutos: 60
                    }])
                },
                className: "px-4 py-2 bg-gray-200 text-gray-700 rounded-lg font-semibold hover:bg-gray-300"
            }, "➕ Adicionar Faixa"), React.createElement("button", {
                onClick: () => {
                    const e = document.getElementById("bi-novo-codigo").value;
                    if (!e) return ja("Selecione um cliente ou centro", "error");
                    const [t, a, l] = e.split(":");
                    (async (e, t, a, l) => {
                        try {
                            const r = await fetch(`${API_URL}/bi/prazos`, {
                                    method: "POST",
                                    headers: {
                                        "Content-Type": "application/json"
                                    },
                                    body: JSON.stringify({
                                        tipo: e,
                                        codigo: t,
                                        nome: a,
                                        faixas: l
                                    })
                                }),
                                o = await r.json();
                            o.success ? (ja("✅ Prazo salvo!", "success"), tl(), xl()) : ja("❌ Erro: " + o.error, "error")
                        } catch (e) {
                            ja("Erro ao salvar", "error")
                        }
                    })(t, a, l, ya), va([{
                        km_min: 0,
                        km_max: 15,
                        prazo_minutos: 45
                    }]), document.getElementById("bi-novo-codigo").value = ""
                },
                className: "px-4 py-2 bg-purple-600 text-white rounded-lg font-semibold hover:bg-purple-700"
            }, "💾 Salvar Configuração"))), React.createElement("div", {
                className: "bg-white rounded-xl shadow p-6"
            }, React.createElement("h2", {
                className: "text-xl font-bold text-purple-900 mb-4"
            }, "📋 Prazos Configurados (", yt.length, ")"), 0 === yt.length ? React.createElement("p", {
                className: "text-gray-500 text-center py-8"
            }, "Nenhum prazo específico configurado") : React.createElement("div", {
                className: "space-y-3"
            }, yt.map(e => React.createElement("div", {
                key: e.id,
                className: "border border-purple-200 rounded-lg p-4 bg-purple-50"
            }, React.createElement("div", {
                className: "flex justify-between items-start mb-3"
            }, React.createElement("div", null, React.createElement("span", {
                className: "text-xs px-2 py-0.5 rounded " + ("cliente" === e.tipo ? "bg-blue-100 text-blue-700" : "bg-green-100 text-green-700")
            }, "cliente" === e.tipo ? "👤 Cliente" : "🏢 Centro de Custo"), React.createElement("p", {
                className: "font-semibold mt-1 text-purple-900"
            }, e.nome || e.codigo)), React.createElement("button", {
                onClick: () => (async e => {
                    if (confirm("Remover esta configuração de prazo?")) try {
                        await fetch(`${API_URL}/bi/prazos/${e}`, {
                            method: "DELETE"
                        }), ja("✅ Removido!", "success"), tl()
                    } catch (e) {
                        ja("Erro ao remover", "error")
                    }
                })(e.id),
                className: "text-red-500 hover:text-red-700 p-1"
            }, "🗑️")), React.createElement("div", {
                className: "flex flex-wrap gap-2"
            }, e.faixas && e.faixas.map((e, t) => React.createElement("span", {
                key: t,
                className: "bg-white border border-purple-300 px-3 py-1 rounded text-sm"
            }, e.km_min, " - ", e.km_max || "∞", " km → ", React.createElement("strong", null, e.prazo_minutos, " min"))))))))), !ft && "dashboard" === Et && React.createElement("div", {
                className: "bg-white rounded-xl shadow p-10 text-center"
            }, React.createElement("p", {
                className: "text-5xl mb-4"
            }, "📊"), React.createElement("p", {
                className: "text-gray-500"
            }, "Nenhum dado encontrado"), React.createElement("p", {
                className: "text-sm text-gray-400 mt-2"
            }, 'Faça upload de uma planilha na aba "Upload"')))))
        }
        const rr = "admin_master" === l.role && ("solicitacoes" === Ee || "disponibilidade" === Ee),
            or = "admin" === l.role;
        return React.createElement("div", {
            className: "min-h-screen bg-gray-50"
        }, i && React.createElement(Toast, i), n && React.createElement(LoadingOverlay, null), React.createElement(ConfigModal, {
            show: p.showConfigModal,
            onClose: () => x({...p, showConfigModal: false}),
            users: A,
            loadUsers: Ia,
            showToast: ja,
            setLoading: s,
            currentUser: l,
            state: p,
            setState: x
        }), u && React.createElement(ImageModal, {
            imageUrl: u,
            onClose: () => g(null)
        }), rr ? React.createElement("nav", {
            className: "bg-gradient-to-r from-indigo-900 to-purple-900 shadow-lg"
        }, React.createElement("div", {
            className: "max-w-7xl mx-auto px-4 py-4 flex justify-between items-center"
        }, React.createElement("div", {
            className: "flex items-center gap-4"
        }, React.createElement("div", null, React.createElement("h1", {
            className: "text-xl font-bold text-white"
        }, "👑 Admin Master"), React.createElement("p", {
            className: "text-xs text-indigo-200"
        }, l.fullName)), React.createElement("div", {
            className: "flex bg-white/10 rounded-lg p-1"
        }, React.createElement("button", {
            onClick: () => {
                he("solicitacoes"), x(e => ({
                    ...e,
                    adminTab: "dashboard"
                }))
            },
            className: "px-4 py-2 rounded-lg text-sm font-semibold transition-all " + ("solicitacoes" === Ee && "disponibilidade" !== p.adminTab ? "bg-white text-purple-900" : "text-white hover:bg-white/10")
        }, "📋 Solicitações"), React.createElement("button", {
            onClick: () => he("financeiro"),
            className: "px-4 py-2 rounded-lg text-sm font-semibold transition-all " + ("financeiro" === Ee ? "bg-white text-green-800" : "text-white hover:bg-white/10")
        }, "💰 Financeiro"), React.createElement("button", {
            onClick: () => {
                he("solicitacoes"), x(e => ({
                    ...e,
                    adminTab: "disponibilidade"
                }))
            },
            className: "px-4 py-2 rounded-lg text-sm font-semibold transition-all " + ("solicitacoes" === Ee && "disponibilidade" === p.adminTab ? "bg-white text-blue-800" : "text-white hover:bg-white/10")
        }, "📅 Disponibilidade"), React.createElement("button", {
            onClick: () => {
                he("bi"), ll(), tl(), al(), dl(), pl()
            },
            className: "px-4 py-2 rounded-lg text-sm font-semibold transition-all " + ("bi" === Ee ? "bg-white text-orange-800" : "text-white hover:bg-white/10")
        }, "📊 BI"), React.createElement("button", {
            onClick: () => he("todo"),
            className: "px-4 py-2 rounded-lg text-sm font-semibold transition-all " + ("todo" === Ee ? "bg-white text-indigo-800" : "text-white hover:bg-white/10")
        }, "📋 TO-DO"), React.createElement("button", {
                onClick: () => he("operacional"),
                className: "px-4 py-2 rounded-lg text-sm font-semibold transition-all " + ("operacional" === Ee ? "bg-white text-teal-800" : "text-white hover:bg-white/10")
            }, "⚙️ Operacional"))), React.createElement("div", {
            className: "flex items-center gap-3"
        }, React.createElement("div", {
            className: "flex items-center gap-2 bg-white/10 px-3 py-1 rounded-full"
        }, React.createElement("span", {
            className: "w-2 h-2 rounded-full " + (f ? "bg-yellow-400 animate-pulse" : "bg-green-400")
        }), React.createElement("span", {
            className: "text-xs text-indigo-200"
        }, f ? "Atualizando..." : E ? `${E.toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"})}` : "⚡ 10s")), React.createElement("button", {
            onClick: ul,
            className: "px-4 py-2 bg-white/20 text-white rounded-lg hover:bg-white/30 text-sm font-semibold"
        }, "🔄"), React.createElement("button", {
            onClick: () => o(null),
            className: "px-4 py-2 text-white hover:bg-white/20 rounded-lg"
        }, "Sair")))) : or ? React.createElement("nav", {
            className: "bg-purple-900 shadow-lg"
        }, React.createElement("div", {
            className: "max-w-7xl mx-auto px-4 py-4 flex justify-between items-center"
        }, React.createElement("div", {
            className: "flex items-center gap-3"
        }, React.createElement("h1", {
            className: "text-xl font-bold text-white"
        }, "Painel Admin"), React.createElement("div", {
            className: "flex bg-purple-800/50 rounded-lg p-1"
        }, React.createElement("button", {
            onClick: () => {
                he("solicitacoes"), x(e => ({
                    ...e,
                    adminTab: "dashboard"
                }))
            },
            className: "px-3 py-1.5 rounded-lg text-sm font-semibold transition-all " + ("disponibilidade" !== p.adminTab ? "bg-white text-purple-900" : "text-white hover:bg-white/10")
        }, "📋 Solicitações"), React.createElement("button", {
            onClick: () => {
                he("solicitacoes"), x(e => ({
                    ...e,
                    adminTab: "disponibilidade"
                }))
            },
            className: "px-3 py-1.5 rounded-lg text-sm font-semibold transition-all " + ("disponibilidade" === p.adminTab ? "bg-white text-blue-800" : "text-white hover:bg-white/10")
        }, "📅 Disponibilidade")), React.createElement("div", {
            className: "flex items-center gap-2 bg-purple-800/50 px-3 py-1 rounded-full"
        }, React.createElement("span", {
            className: "w-2 h-2 rounded-full " + (f ? "bg-yellow-400 animate-pulse" : "bg-green-400")
        }), React.createElement("span", {
            className: "text-xs text-purple-200"
        }, f ? "Atualizando..." : E ? `${E.toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"})}` : "⚡ 10s"))), React.createElement("div", {
            className: "flex gap-2"
        }, React.createElement("button", {
            onClick: ul,
            className: "px-4 py-2 bg-purple-700 text-white rounded-lg hover:bg-purple-600 text-sm font-semibold"
        }, "🔄 Atualizar"), "admin_master" === l.role && React.createElement("button", {
            onClick: function() { x({...p, showConfigModal: true}); },
            className: "px-4 py-2 bg-purple-700 text-white rounded-lg hover:bg-purple-600 text-sm font-semibold"
        }, "⚙️"), React.createElement("button", {
            onClick: () => o(null),
            className: "px-4 py-2 text-white hover:bg-purple-800 rounded-lg"
        }, "Sair")))) : null, "disponibilidade" !== p.adminTab && React.createElement("div", {
            className: "bg-white border-b sticky top-0 z-10"
        }, React.createElement("div", {
            className: "max-w-7xl mx-auto px-4 flex gap-1 overflow-x-auto"
        }, ["dashboard", "search", "ranking", "relatorios"].map(e => React.createElement("button", {
            key: e,
            onClick: () => x({
                ...p,
                adminTab: e
            }),
            className: "px-4 py-2.5 text-sm font-semibold whitespace-nowrap " + (!p.adminTab && "dashboard" === e || p.adminTab === e ? "text-purple-900 border-b-2 border-purple-900" : "text-gray-600")
        }, "dashboard" === e && "📊 Dashboard", "search" === e && "🔍 Busca Detalhada", "ranking" === e && "🏆 Ranking", "relatorios" === e && "📈 Relatórios", "users" === e && "👥 Usuários")))), React.createElement("div", {
            className: "max-w-7xl mx-auto p-6"
        }, (!p.adminTab || "dashboard" === p.adminTab) && React.createElement(React.Fragment, null, (() => {
            const e = e => {
                    const t = new Date(e),
                        a = t.getDay(),
                        l = t.getHours() + t.getMinutes() / 60;
                    return 0 !== a && (6 === a ? l >= 8 && l < 12 : l >= 9 && l < 18)
                },
                t = new Date;
            t.setHours(0, 0, 0, 0);
            const a = j.filter(e => new Date(e.created_at) >= t),
                l = a.filter(e => "pendente" !== e.status),
                r = j.filter(t => "pendente" !== t.status && t.updated_at && t.created_at && e(t.created_at)).map(e => (new Date(e.updated_at) - new Date(e.created_at)) / 36e5),
                o = r.length > 0 ? r.reduce((e, t) => e + t, 0) / r.length : 0,
                c = j.filter(t => "pendente" === t.status && e(t.created_at) && Date.now() - new Date(t.created_at).getTime() >= 864e5),
                s = 0 === c.length ? 100 : Math.max(0, 100 - 15 * c.length),
                n = o <= 6 ? 100 : o <= 12 ? 80 : o <= 24 ? 60 : 40,
                m = Math.round((s + n) / 2);
            return React.createElement(React.Fragment, null, React.createElement("div", {
                className: "grid grid-cols-2 md:grid-cols-5 gap-4 mb-6"
            }, React.createElement("div", {
                className: "bg-white p-4 rounded-xl shadow"
            }, React.createElement("p", {
                className: "text-sm text-gray-600"
            }, "Total"), React.createElement("p", {
                className: "text-2xl font-bold text-purple-900"
            }, j.length)), React.createElement("div", {
                className: "bg-white p-4 rounded-xl shadow"
            }, React.createElement("p", {
                className: "text-sm text-gray-600"
            }, "Pendentes"), React.createElement("p", {
                className: "text-2xl font-bold text-yellow-600"
            }, j.filter(e => "pendente" === e.status).length)), React.createElement("div", {
                className: "bg-white p-4 rounded-xl shadow"
            }, React.createElement("p", {
                className: "text-sm text-gray-600"
            }, "Aprovadas"), React.createElement("p", {
                className: "text-2xl font-bold text-green-600"
            }, j.filter(e => "aprovada" === e.status).length)), React.createElement("div", {
                className: "bg-white p-4 rounded-xl shadow"
            }, React.createElement("p", {
                className: "text-sm text-gray-600"
            }, "Rejeitadas"), React.createElement("p", {
                className: "text-2xl font-bold text-red-600"
            }, j.filter(e => "rejeitada" === e.status).length)), React.createElement("div", {
                className: "bg-white p-4 rounded-xl shadow"
            }, React.createElement("p", {
                className: "text-sm text-gray-600"
            }, "🚨 Atrasadas (+24h)"), React.createElement("p", {
                className: "text-2xl font-bold " + (c.length > 0 ? "text-red-600 animate-pulse" : "text-gray-400")
            }, c.length))), c.length > 0 && React.createElement("div", {
                className: "bg-red-50 border-2 border-red-400 rounded-xl p-4 mb-6 animate-pulse"
            }, React.createElement("div", {
                className: "flex items-center gap-3"
            }, React.createElement("span", {
                className: "text-3xl"
            }, "🚨"), React.createElement("div", {
                className: "flex-1"
            }, React.createElement("p", {
                className: "text-red-800 font-bold text-lg"
            }, "ATENÇÃO: ", c.length, " solicitação(ões) aguardando há mais de 24 horas!"), React.createElement("p", {
                className: "text-red-600 text-sm mt-1"
            }, "OS: ", c.slice(0, 5).map(e => e.ordemServico).join(", "), c.length > 5 ? "..." : "")))), React.createElement("div", {
                className: "bg-gradient-to-r from-purple-600 to-indigo-600 rounded-xl shadow-lg p-6 mb-6 text-white"
            }, React.createElement("div", {
                className: "flex flex-col md:flex-row items-center gap-6"
            }, React.createElement("div", {
                className: "relative w-28 h-28"
            }, React.createElement("svg", {
                className: "w-28 h-28 transform -rotate-90"
            }, React.createElement("circle", {
                cx: "56",
                cy: "56",
                r: "48",
                stroke: "rgba(255,255,255,0.2)",
                strokeWidth: "10",
                fill: "none"
            }), React.createElement("circle", {
                cx: "56",
                cy: "56",
                r: "48",
                stroke: m >= 80 ? "#10b981" : m >= 50 ? "#f59e0b" : "#ef4444",
                strokeWidth: "10",
                fill: "none",
                strokeDasharray: 3.02 * m + " 302",
                strokeLinecap: "round"
            })), React.createElement("div", {
                className: "absolute inset-0 flex flex-col items-center justify-center"
            }, React.createElement("span", {
                className: "text-2xl font-bold"
            }, m), React.createElement("span", {
                className: "text-xs opacity-70"
            }, "SCORE"))), React.createElement("div", {
                className: "flex-1 grid grid-cols-2 md:grid-cols-4 gap-4"
            }, React.createElement("div", {
                className: "bg-white/10 rounded-lg p-3 text-center"
            }, React.createElement("p", {
                className: "text-white/70 text-xs"
            }, "Hoje"), React.createElement("p", {
                className: "text-xl font-bold"
            }, a.length), React.createElement("p", {
                className: "text-xs text-white/60"
            }, l.length, " processadas")), React.createElement("div", {
                className: "bg-white/10 rounded-lg p-3 text-center"
            }, React.createElement("p", {
                className: "text-white/70 text-xs"
            }, "Tempo Médio"), React.createElement("p", {
                className: "text-xl font-bold"
            }, o < 1 ? `${Math.round(60*o)}min` : `${o.toFixed(1)}h`), React.createElement("p", {
                className: "text-xs " + (o <= 12 ? "text-green-300" : o <= 24 ? "text-yellow-300" : "text-red-300")
            }, o <= 6 ? "✅ Excelente" : o <= 12 ? "✅ Bom" : o <= 24 ? "⚠️ Regular" : "🚨 Lento")), React.createElement("div", {
                className: "bg-white/10 rounded-lg p-3 text-center"
            }, React.createElement("p", {
                className: "text-white/70 text-xs"
            }, "Pendentes"), React.createElement("p", {
                className: "text-xl font-bold"
            }, j.filter(e => "pendente" === e.status).length), React.createElement("p", {
                className: "text-xs text-white/60"
            }, "aguardando")), React.createElement("div", {
                className: "bg-white/10 rounded-lg p-3 text-center"
            }, React.createElement("p", {
                className: "text-white/70 text-xs"
            }, "Prazo (24h)"), React.createElement("p", {
                className: "text-xl font-bold " + (0 === c.length ? "text-green-300" : "text-red-300")
            }, 0 === c.length ? "✅" : `${c.length} 🚨`), React.createElement("p", {
                className: "text-xs text-white/60"
            }, 0 === c.length ? "Nenhum atraso" : "Ação necessária!"))))))
        })(), React.createElement("div", {
            className: "grid md:grid-cols-2 gap-6 mb-6"
        }, React.createElement(MotivosPieChart, {
            submissions: j
        }), React.createElement(PieChart, {
            data: [{
                label: "✓ Aprovadas",
                value: j.filter(e => "aprovada" === e.status).length,
                color: "#22c55e"
            }, {
                label: "✗ Rejeitadas",
                value: j.filter(e => "rejeitada" === e.status).length,
                color: "#ef4444"
            }, {
                label: "⏳ Pendentes",
                value: j.filter(e => "pendente" === e.status).length,
                color: "#fbbf24"
            }],
            title: "📈 Status das Solicitações"
        })), React.createElement("div", {
            className: "bg-white rounded-xl shadow p-6"
        }, React.createElement("h2", {
            className: "text-lg font-semibold mb-4"
        }, "Aguardando Validação"), React.createElement("div", {
            className: "mb-4 flex flex-wrap gap-2"
        }, ["all", "atrasados", "retorno", "ponto1", "pedagio"].map(e => React.createElement("button", {
            key: e,
            onClick: () => x({
                ...p,
                pendingFilter: e
            }),
            className: "px-4 py-2 rounded-lg font-semibold " + ((p.pendingFilter || "all") === e ? "atrasados" === e ? "bg-red-600 text-white" : "bg-purple-600 text-white" : "bg-gray-100")
        }, "all" === e && `📋 Todos (${j.filter(e=>"pendente"===e.status).length})`, "atrasados" === e && `🚨 Atrasados (${j.filter(e=>"pendente"===e.status&&Date.now()-new Date(e.created_at).getTime()>=864e5).length})`, "retorno" === e && `🔄 Retorno (${j.filter(e=>"pendente"===e.status&&"Ajuste de Retorno"===e.motivo).length})`, "ponto1" === e && `📍 Ponto 1 (${j.filter(e=>"pendente"===e.status&&e.motivo?.includes("Ponto 1")).length})`, "pedagio" === e && `🛣️ Pedágio (${j.filter(e=>"pendente"===e.status&&e.motivo?.includes("Pedágio")).length})`))), React.createElement("div", {
            className: "grid md:grid-cols-2 lg:grid-cols-3 gap-3"
        }, j.filter(e => "pendente" === e.status && (!p.pendingFilter || "all" === p.pendingFilter || ("atrasados" === p.pendingFilter ? Date.now() - new Date(e.created_at).getTime() >= 864e5 : "retorno" === p.pendingFilter ? "Ajuste de Retorno" === e.motivo : "ponto1" === p.pendingFilter ? e.motivo?.includes("Ponto 1") : "pedagio" !== p.pendingFilter || e.motivo?.includes("Pedágio")))).map(e => {
            const t = Date.now() - new Date(e.created_at).getTime(),
                a = Math.floor(t / 36e5),
                l = Math.floor(t % 36e5 / 6e4),
                r = t >= 864e5,
                o = t >= 36e6 && !r,
                rtnW = (() => {
                    if ("Ajuste de Retorno" !== e.motivo) return 0;
                    const t = new Date,
                        a = t.getDay(),
                        l = new Date(t);
                    l.setDate(t.getDate() - a), l.setHours(0, 0, 0, 0);
                    return j.filter(t => "Ajuste de Retorno" === t.motivo && t.codProfissional === e.codProfissional && new Date(t.created_at) >= l).length
                })(),
                rtnM = (() => {
                    if ("Ajuste de Retorno" !== e.motivo) return 0;
                    const t = new Date,
                        a = new Date(t.getFullYear(), t.getMonth(), 1);
                    return j.filter(t => "Ajuste de Retorno" === t.motivo && t.codProfissional === e.codProfissional && new Date(t.created_at) >= a).length
                })(),
                hasAlert = rtnW > 3 || rtnM > 5;
            return React.createElement("div", {
                key: e.id,
                className: "border-2 rounded-lg p-3 text-sm " + (hasAlert ? "border-yellow-500 bg-yellow-50 ring-2 ring-yellow-400" : r ? "border-red-400 bg-red-50" : o ? "border-orange-300 bg-orange-50" : "border-gray-200")
            }, hasAlert && React.createElement("div", {
                className: "mb-2 p-2 bg-yellow-200 rounded-lg text-xs font-bold text-yellow-900 flex items-center gap-2"
            }, React.createElement("span", {
                className: "text-lg"
            }, "⚠️"), React.createElement("span", null, "ATENÇÃO: ", rtnW > 3 ? `${rtnW} retornos na semana (máx 3)` : "", " ", rtnM > 5 ? `| ${rtnM} retornos no mês (máx 5)` : "")), React.createElement("div", {
                className: "flex justify-between items-start mb-2"
            }, React.createElement("p", {
                className: "font-mono text-lg font-bold"
            }, "OS: ", e.ordemServico), React.createElement("span", {
                className: "px-2 py-0.5 rounded text-xs font-bold " + (r ? "bg-red-500 text-white animate-pulse" : o ? "bg-orange-400 text-white" : "bg-gray-100 text-gray-600")
            }, r ? "🚨" : o ? "⚠️" : "⏱️", a > 0 ? `${a}h ${l}m` : `${l}min`)), React.createElement("p", {
                className: "text-xs text-gray-700"
            }, e.fullName), React.createElement("p", {
                className: "text-xs text-gray-500 font-mono"
            }, "COD: ", e.codProfissional), React.createElement("p", {
                className: "text-xs text-purple-900 font-semibold"
            }, e.motivo), React.createElement("p", {
                className: "text-[10px] text-gray-500 mt-1"
            }, "📅 ", new Date(e.created_at).toLocaleDateString("pt-BR"), " às ", new Date(e.created_at).toLocaleTimeString("pt-BR", {
                hour: "2-digit",
                minute: "2-digit"
            })), e.coordenadas && React.createElement("div", {
                className: "mt-2 bg-green-50 border border-green-200 rounded p-2"
            }, React.createElement("p", {
                className: "text-xs font-mono text-green-900"
            }, e.coordenadas), React.createElement("div", {
                className: "flex gap-2 mt-1"
            }, React.createElement("button", {
                onClick: () => {
                    navigator.clipboard.writeText(e.coordenadas), ja("Copiado!", "success")
                },
                className: "text-xs text-green-600"
            }, "📋 Copiar"), React.createElement("a", {
                href: `https://www.google.com/maps?q=${e.coordenadas}`,
                target: "_blank",
                className: "text-xs text-green-600"
            }, "🗺️ Maps"))), e.temImagem && React.createElement("div", {
                className: "mt-2"
            }, e.imagemComprovante ? React.createElement(React.Fragment, null, React.createElement("div", {
                className: "flex gap-2 flex-wrap"
            }, e.imagemComprovante.split("|||").map((e, t) => React.createElement("img", {
                key: t,
                src: e,
                className: "h-20 rounded cursor-pointer",
                onClick: () => g(e)
            }))), React.createElement("button", {
                onClick: () => C(t => t.map(t => t.id === e.id ? {
                    ...t,
                    imagemComprovante: null
                } : t)),
                className: "text-xs text-gray-500"
            }, "▲ Ocultar")) : React.createElement("button", {
                onClick: () => {
                    ja("🔄 Carregando...", "success"), Fa(e.id)
                },
                className: "px-2 py-1 bg-blue-100 text-blue-800 rounded text-xs font-semibold"
            }, "📷 Ver foto(s)")), React.createElement("textarea", {
                placeholder: "Obs (opcional)",
                value: p[`obs_${e.id}`] || "",
                onChange: t => x({
                    ...p,
                    [`obs_${e.id}`]: t.target.value
                }),
                className: "w-full px-2 py-1 border rounded mt-2 text-xs",
                rows: "1"
            }), React.createElement("div", {
                className: "flex gap-2 mt-2"
            }, React.createElement("button", {
                onClick: () => Kl(e.id, !0),
                className: "flex-1 bg-green-600 text-white py-1 rounded text-xs font-semibold"
            }, "✓ Aprovar"), React.createElement("button", {
                onClick: () => Kl(e.id, !1),
                className: "flex-1 bg-red-600 text-white py-1 rounded text-xs font-semibold"
            }, "✗ Rejeitar")))
        })))), "search" === p.adminTab && React.createElement("div", {
            className: "bg-white rounded-xl shadow p-6"
        }, React.createElement("div", {
            className: "flex flex-wrap gap-4 mb-6"
        }, React.createElement("input", {
            type: "text",
            placeholder: "🔍 Buscar por OS ou código...",
            value: p.searchOS || "",
            onChange: e => x({
                ...p,
                searchOS: e.target.value
            }),
            className: "flex-1 px-4 py-2 border rounded-lg"
        }), React.createElement("select", {
            value: p.statusFilter || "",
            onChange: e => x({
                ...p,
                statusFilter: e.target.value
            }),
            className: "px-4 py-2 border rounded-lg"
        }, React.createElement("option", {
            value: ""
        }, "Todos status"), React.createElement("option", {
            value: "pendente"
        }, "Pendente"), React.createElement("option", {
            value: "aprovada"
        }, "Aprovada"), React.createElement("option", {
            value: "rejeitada"
        }, "Rejeitada")), React.createElement("select", {
            value: p.dateFilter || "",
            onChange: e => x({
                ...p,
                dateFilter: e.target.value
            }),
            className: "px-4 py-2 border rounded-lg"
        }, React.createElement("option", {
            value: ""
        }, "Todo período"), React.createElement("option", {
            value: "today"
        }, "Hoje"), React.createElement("option", {
            value: "week"
        }, "Esta semana"), React.createElement("option", {
            value: "month"
        }, "Este mês"))), React.createElement("div", {
            className: "grid md:grid-cols-2 lg:grid-cols-3 gap-3"
        }, j.filter(e => {
            if (p.searchOS && !e.ordemServico?.toLowerCase().includes(p.searchOS.toLowerCase()) && !e.codProfissional?.toLowerCase().includes(p.searchOS.toLowerCase())) return !1;
            if (p.statusFilter && e.status !== p.statusFilter) return !1;
            if (p.dateFilter) {
                const t = new Date;
                t.setHours(0, 0, 0, 0);
                const a = new Date(e.created_at);
                if ("today" === p.dateFilter) {
                    const e = new Date(t);
                    if (e.setDate(e.getDate() + 1), a < t || a >= e) return !1
                } else if ("week" === p.dateFilter) {
                    const e = new Date(t);
                    if (e.setDate(e.getDate() - 7), a < e) return !1
                } else if ("month" === p.dateFilter) {
                    const e = new Date(t);
                    if (e.setMonth(e.getMonth() - 1), a < e) return !1
                }
            }
            return !0
        }).map(e => React.createElement("div", {
            key: e.id,
            className: "border rounded-lg p-3 text-sm " + ("aprovada" === e.status ? "bg-green-50" : "rejeitada" === e.status ? "bg-red-50" : "bg-yellow-50")
        }, React.createElement("div", {
            className: "flex justify-between items-start mb-1"
        }, React.createElement("div", null, React.createElement("p", {
            className: "font-mono font-bold"
        }, "OS: ", e.ordemServico), React.createElement("p", {
            className: "text-xs text-gray-700"
        }, e.fullName)), React.createElement("div", {
            className: "flex items-center gap-1"
        }, React.createElement("span", {
            className: "px-2 py-0.5 rounded-full text-xs font-bold " + ("aprovada" === e.status ? "bg-green-600 text-white" : "rejeitada" === e.status ? "bg-red-600 text-white" : "bg-yellow-600 text-white")
        }, e.status?.toUpperCase()), React.createElement("button", {
            onClick: async () => {
                confirm(`Excluir OS ${e.ordemServico}?`) && (await fetch(`${API_URL}/submissions/${e.id}`, {
                    method: "DELETE"
                }), ja("🗑️ Excluída!", "success"), La())
            },
            className: "px-1.5 py-0.5 bg-red-600 text-white rounded text-xs"
        }, "🗑️"))), React.createElement("p", {
            className: "text-xs text-gray-600"
        }, e.motivo), e.coordenadas && React.createElement("div", {
            className: "mt-1 bg-green-50 border border-green-200 rounded p-1.5 flex items-center justify-between"
        }, React.createElement("p", {
            className: "text-xs font-mono text-green-900"
        }, e.coordenadas), React.createElement("button", {
            onClick: () => {
                navigator.clipboard.writeText(e.coordenadas), ja("📋 Copiado!", "success")
            },
            className: "px-1.5 py-0.5 bg-green-600 text-white text-xs rounded"
        }, "📋")), e.temImagem && React.createElement("div", {
            className: "mt-1"
        }, e.imagemComprovante ? React.createElement(React.Fragment, null, React.createElement("div", {
            className: "flex gap-1 flex-wrap"
        }, e.imagemComprovante.split("|||").map((e, t) => React.createElement("img", {
            key: t,
            src: e,
            className: "h-20 rounded cursor-pointer",
            onClick: () => g(e)
        }))), React.createElement("button", {
            onClick: () => C(t => t.map(t => t.id === e.id ? {
                ...t,
                imagemComprovante: null
            } : t)),
            className: "text-xs text-gray-500"
        }, "▲ Ocultar")) : React.createElement("button", {
            onClick: () => {
                ja("🔄 Carregando...", "success"), Fa(e.id)
            },
            className: "px-2 py-0.5 bg-blue-100 text-blue-800 rounded text-xs font-semibold"
        }, "📷 Ver foto(s)")), e.observacao && React.createElement("div", {
            className: "mt-1 bg-white p-1 rounded border"
        }, React.createElement("p", {
            className: "text-xs text-gray-600"
        }, "Obs: ", e.observacao)), React.createElement("div", {
            className: "flex justify-between items-center mt-1"
        }, React.createElement("p", {
            className: "text-xs text-gray-400"
        }, e.timestamp), e.validated_by_name && "pendente" !== e.status && React.createElement("p", {
            className: "text-xs text-purple-600 font-semibold"
        }, "👤 ", e.validated_by_name)))))), "ranking" === p.adminTab && React.createElement("div", {
            className: "bg-white rounded-xl shadow p-6"
        }, React.createElement("h2", {
            className: "text-lg font-semibold mb-4"
        }, "🏆 Ranking de Retorno - Aprovações"), React.createElement("div", {
            className: "mb-6"
        }, React.createElement("select", {
            value: p.rankingPeriod || "all",
            onChange: e => x({
                ...p,
                rankingPeriod: e.target.value
            }),
            className: "px-4 py-2 border rounded-lg"
        }, React.createElement("option", {
            value: "all"
        }, "📅 Todos os Tempos"), React.createElement("option", {
            value: "today"
        }, "📅 Hoje"), React.createElement("option", {
            value: "week"
        }, "📅 Esta Semana"), React.createElement("option", {
            value: "month"
        }, "📅 Este Mês"))), React.createElement("div", {
            className: "space-y-3"
        }, (() => {
            const e = new Date;
            e.setHours(0, 0, 0, 0);
            const t = j.filter(t => {
                    if ("aprovada" !== t.status || "Ajuste de Retorno" !== t.motivo) return !1;
                    if (!p.rankingPeriod || "all" === p.rankingPeriod) return !0;
                    const a = new Date(t.created_at);
                    if ("today" === p.rankingPeriod) {
                        const t = new Date(e);
                        return t.setDate(t.getDate() + 1), a >= e && a < t
                    }
                    if ("week" === p.rankingPeriod) {
                        const t = new Date(e);
                        return t.setDate(t.getDate() - 7), a >= t
                    }
                    if ("month" === p.rankingPeriod) {
                        const t = new Date(e);
                        return t.setMonth(t.getMonth() - 1), a >= t
                    }
                    return !0
                }),
                a = {};
            t.forEach(e => {
                const t = e.codProfissional || "SEM_COD";
                a[t] || (a[t] = {
                    nome: e.fullName || "Desconhecido",
                    cod: e.codProfissional || "-",
                    total: 0,
                    solicitacoes: []
                });
                a[t].total += 1;
                a[t].solicitacoes.push(e)
            });
            const l = Object.entries(a).sort((e, t) => t[1].total - e[1].total);
            return 0 === l.length ? React.createElement("p", {
                className: "text-gray-500 text-center py-8"
            }, "Sem dados no período") : l.map(([k, v], i) => React.createElement("div", {
                key: i,
                className: "bg-gray-50 rounded-lg hover:bg-gray-100"
            }, React.createElement("div", {
                className: "flex items-center gap-4 p-4 cursor-pointer",
                onClick: () => x({
                    ...p,
                    [`rankingExp_${k}`]: !p[`rankingExp_${k}`]
                })
            }, React.createElement("div", {
                className: "text-3xl font-bold w-12 " + (0 === i ? "text-yellow-500" : 1 === i ? "text-gray-400" : 2 === i ? "text-orange-600" : "text-gray-400")
            }, 0 === i ? "🥇" : 1 === i ? "🥈" : 2 === i ? "🥉" : `${i+1}º`), React.createElement("div", {
                className: "flex-1"
            }, React.createElement("p", {
                className: "font-semibold text-lg text-gray-800"
            }, v.nome), React.createElement("p", {
                className: "text-sm text-gray-500 font-mono"
            }, "COD: ", v.cod)), React.createElement("div", {
                className: "text-right flex items-center gap-3"
            }, React.createElement("div", null, React.createElement("p", {
                className: "text-3xl font-bold text-purple-600"
            }, v.total), React.createElement("p", {
                className: "text-xs text-gray-500"
            }, "aprovações")), React.createElement("button", {
                className: "w-8 h-8 rounded-full bg-purple-600 text-white font-bold text-lg flex items-center justify-center hover:bg-purple-700 transition-all " + (p[`rankingExp_${k}`] ? "rotate-45" : "")
            }, "+"))), p[`rankingExp_${k}`] && React.createElement("div", {
                className: "px-4 pb-4"
            }, React.createElement("div", {
                className: "bg-white rounded-lg border border-gray-200 divide-y divide-gray-100 max-h-64 overflow-y-auto"
            }, v.solicitacoes.map((s, idx) => React.createElement("div", {
                key: idx,
                className: "p-3 hover:bg-gray-50"
            }, React.createElement("div", {
                className: "flex justify-between items-center"
            }, React.createElement("div", null, React.createElement("p", {
                className: "font-mono font-semibold text-sm"
            }, "OS: ", s.ordemServico), React.createElement("p", {
                className: "text-xs text-gray-500"
            }, new Date(s.created_at).toLocaleDateString("pt-BR"), " às ", new Date(s.created_at).toLocaleTimeString("pt-BR", {
                hour: "2-digit",
                minute: "2-digit"
            }))), React.createElement("div", {
                className: "flex items-center gap-2"
            }, s.temImagem && React.createElement("button", {
                onClick: e => {
                    e.stopPropagation();
                    if (s.imagemComprovante) {
                        g(s.imagemComprovante.split("|||")[0])
                    } else {
                        ja("🔄 Carregando...", "success");
                        Fa(s.id)
                    }
                },
                className: "px-2 py-1 bg-blue-100 text-blue-700 text-xs font-semibold rounded hover:bg-blue-200 flex items-center gap-1"
            }, "📷 Ver Foto"), React.createElement("span", {
                className: "px-2 py-1 bg-green-100 text-green-700 text-xs font-semibold rounded"
            }, "✓ Aprovada"))), s.imagemComprovante && React.createElement("div", {
                className: "mt-2 flex gap-2 flex-wrap"
            }, s.imagemComprovante.split("|||").map((img, imgIdx) => React.createElement("img", {
                key: imgIdx,
                src: img,
                className: "h-16 rounded cursor-pointer border border-gray-200 hover:border-purple-400",
                onClick: e => {
                    e.stopPropagation();
                    g(img)
                }
            })))))))))
        })())), "disponibilidade" === p.adminTab && React.createElement(React.Fragment, null, (() => {
            const e = p.dispData || {
                    regioes: [],
                    lojas: [],
                    linhas: []
                },
                t = p.dispSubTab || "panorama",
                a = p.dispLoading,
                r = async () => {
                    try {
                        x(e => ({
                            ...e,
                            dispLoading: !0
                        }));
                        const e = await fetch(`${API_URL}/disponibilidade`);
                        if (!e.ok) throw new Error("Erro ao carregar");
                        const t = await e.json();
                        x(e => ({
                            ...e,
                            dispData: t,
                            dispLoading: !1,
                            dispLoaded: !0
                        }))
                    } catch (e) {
                        console.error("Erro ao carregar disponibilidade:", e), ja("Erro ao carregar dados", "error"), x(e => ({
                            ...e,
                            dispLoading: !1,
                            dispLoaded: !0
                        }))
                    }
                };
            p.dispLoaded || a || (r(), 0 === pe.length && Ta());
            const o = async () => {
                const e = p.novaRegiao?.trim();
                if (e) try {
                    const t = await fetch(`${API_URL}/disponibilidade/regioes`, {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json"
                        },
                        body: JSON.stringify({
                            nome: e
                        })
                    });
                    if (!t.ok) {
                        const e = await t.json();
                        throw new Error(e.error || "Erro ao criar")
                    }
                    x(e => ({
                        ...e,
                        novaRegiao: ""
                    })), ja(`✅ Região "${e}" adicionada!`, "success"), r()
                } catch (e) {
                    ja(e.message, "error")
                } else ja("Digite o nome da região", "error")
            }, c = async (t, a, l) => {
                const r = [...e.linhas || []],
                    o = r.findIndex(e => e.id === t);
                if (-1 === o) return;
                const c = r[o];
                if ("cod_profissional" === a && l && "" !== l.trim()) try {
                    const e = await fetch(`${API_URL}/disponibilidade/restricoes/verificar?cod_profissional=${l}&loja_id=${c.loja_id}`),
                        t = await e.json();
                    if (t.restrito) {
                        const e = t.todas_lojas ? "TODAS AS LOJAS" : `loja ${t.loja_codigo} - ${t.loja_nome}`;
                        return void alert(`🚫 MOTOBOY RESTRITO!\n\nCódigo: ${l}\nRestrito em: ${e}\n\nMotivo: ${t.motivo}\n\nEste motoboy não pode ser inserido nesta loja.`)
                    }
                } catch (e) {
                    console.error("Erro ao verificar restrição:", e)
                }
                r[o] = {
                    ...r[o],
                    [a]: l
                };
                let s = r[o].nome_profissional;
                if ("cod_profissional" === a)
                    if (l && "" !== l.trim()) {
                        if (l.length >= 1) {
                            const e = pe.find(e => e.codigo === l.toString());
                            if (e) s = e.nome, r[o].nome_profissional = e.nome;
                            else {
                                const e = A.find(e => e.codProfissional?.toLowerCase() === l.toLowerCase());
                                e ? (s = e.fullName, r[o].nome_profissional = e.fullName) : (s = "", r[o].nome_profissional = "")
                            }
                        }
                    } else s = "", r[o].nome_profissional = "";
                x(t => ({
                    ...t,
                    dispData: {
                        ...e,
                        linhas: r
                    }
                })), clearTimeout(window.dispDebounce), window.dispDebounce = setTimeout(async () => {
                    try {
                        await fetch(`${API_URL}/disponibilidade/linhas/${t}`, {
                            method: "PUT",
                            headers: {
                                "Content-Type": "application/json"
                            },
                            body: JSON.stringify({
                                cod_profissional: r[o].cod_profissional || null,
                                nome_profissional: "cod_profissional" === a ? s || null : r[o].nome_profissional || null,
                                status: r[o].status,
                                observacao: r[o].observacao
                            })
                        })
                    } catch (e) {
                        console.error("Erro ao salvar linha:", e)
                    }
                }, 500)
            }, s = async (e, t, a = !1) => {
                try {
                    await fetch(`${API_URL}/disponibilidade/linhas`, {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json"
                        },
                        body: JSON.stringify({
                            loja_id: e,
                            quantidade: t,
                            is_excedente: a
                        })
                    }), ja(`✅ ${t} ${a?"excedente(s)":"titular(es)"} adicionado(s)!`, "success"), r()
                } catch (e) {
                    ja("Erro ao adicionar linhas", "error")
                }
            }, n = {
                "A CONFIRMAR": "bg-yellow-100 text-yellow-800 border-yellow-300",
                CONFIRMADO: "bg-green-100 text-green-800 border-green-300",
                "A CAMINHO": "bg-orange-100 text-orange-800 border-orange-300",
                "EM LOJA": "bg-blue-100 text-blue-800 border-blue-300",
                FALTANDO: "bg-red-100 text-red-800 border-red-300",
                "SEM CONTATO": "bg-gray-100 text-gray-800 border-gray-300"
            }, m = {
                "A CONFIRMAR": "bg-yellow-50",
                CONFIRMADO: "bg-green-50",
                "A CAMINHO": "bg-orange-50",
                "EM LOJA": "bg-blue-50",
                FALTANDO: "bg-red-50",
                "SEM CONTATO": "bg-gray-50"
            };
            return a ? React.createElement("div", {
                className: "flex items-center justify-center py-12"
            }, React.createElement("div", {
                className: "text-center"
            }, React.createElement("div", {
                className: "animate-spin rounded-full h-12 w-12 border-b-2 border-purple-600 mx-auto"
            }), React.createElement("p", {
                className: "mt-4 text-gray-600"
            }, "Carregando..."))) : React.createElement("div", {
                className: "space-y-4"
            }, React.createElement("div", {
                className: "flex items-center justify-end gap-2 text-xs text-gray-500"
            }, React.createElement("span", {
                className: "flex items-center gap-1"
            }, React.createElement("span", {
                className: "w-2 h-2 bg-green-500 rounded-full animate-pulse"
            }), "Sincronização automática ativa (10s)")), React.createElement("div", {
                className: "bg-white rounded-xl shadow"
            }, React.createElement("div", {
                className: "flex border-b overflow-x-auto"
            }, React.createElement("button", {
                onClick: () => x({
                    ...p,
                    dispSubTab: "panorama"
                }),
                className: "px-3 py-2 font-semibold text-sm whitespace-nowrap " + ("panorama" === t ? "text-purple-700 border-b-2 border-purple-600 bg-purple-50" : "text-gray-600")
            }, "📊 Panorama"), React.createElement("button", {
                onClick: () => x({
                    ...p,
                    dispSubTab: "principal"
                }),
                className: "px-3 py-2 font-semibold text-sm whitespace-nowrap " + ("principal" === t ? "text-purple-700 border-b-2 border-purple-600 bg-purple-50" : "text-gray-600")
            }, "📋 Painel"), React.createElement("button", {
                onClick: async () => {
                    x(e => ({
                        ...e,
                        dispSubTab: "faltosos"
                    }));
                    try {
                        const e = await fetch(`${API_URL}/disponibilidade/faltosos`),
                            t = await e.json();
                        x(e => ({
                            ...e,
                            faltososLista: t
                        }))
                    } catch (e) {
                        console.error("Erro ao carregar faltosos:", e)
                    }
                },
                className: "px-3 py-2 font-semibold text-sm whitespace-nowrap " + ("faltosos" === t ? "text-purple-700 border-b-2 border-purple-600 bg-purple-50" : "text-gray-600")
            }, "⚠️ Faltosos"), React.createElement("button", {
                onClick: async () => {
                    x(e => ({
                        ...e,
                        dispSubTab: "espelho"
                    }));
                    try {
                        const e = await fetch(`${API_URL}/disponibilidade/espelho`),
                            t = await e.json();
                        x(e => ({
                            ...e,
                            espelhoDatas: t
                        }))
                    } catch (e) {
                        console.error("Erro ao carregar datas espelho:", e)
                    }
                },
                className: "px-3 py-2 font-semibold text-sm whitespace-nowrap " + ("espelho" === t ? "text-purple-700 border-b-2 border-purple-600 bg-purple-50" : "text-gray-600")
            }, "🪞 Espelho"), React.createElement("button", {
                onClick: async () => {
                    x(e => ({
                        ...e,
                        dispSubTab: "relatorios",
                        relatoriosLoading: !0
                    }));
                    try {
                        const [e, t, a, l, r] = await Promise.all([fetch(`${API_URL}/disponibilidade/relatorios/metricas`).then(e => e.json()).catch(() => []), fetch(`${API_URL}/disponibilidade/relatorios/ranking-lojas`).then(e => e.json()).catch(() => []), fetch(`${API_URL}/disponibilidade/relatorios/ranking-faltosos`).then(e => e.json()).catch(() => []), fetch(`${API_URL}/disponibilidade/relatorios/comparativo`).then(e => e.json()).catch(() => ({})), fetch(`${API_URL}/disponibilidade/relatorios/heatmap`).then(e => e.json()).catch(() => ({
                            diasSemana: [],
                            lojas: []
                        }))]);
                        x(o => ({
                            ...o,
                            relatoriosData: {
                                metricas: Array.isArray(e) ? e : [],
                                rankingLojas: Array.isArray(t) ? t : [],
                                rankingFaltosos: Array.isArray(a) ? a : [],
                                comparativo: l || {},
                                heatmap: r || {
                                    diasSemana: [],
                                    lojas: []
                                }
                            },
                            relatoriosLoading: !1
                        }))
                    } catch (e) {
                        console.error("Erro ao carregar relatórios:", e), x(e => ({
                            ...e,
                            relatoriosLoading: !1,
                            relatoriosData: {
                                metricas: [],
                                rankingLojas: [],
                                rankingFaltosos: [],
                                comparativo: {},
                                heatmap: {
                                    diasSemana: [],
                                    lojas: []
                                }
                            }
                        }))
                    }
                },
                className: "px-3 py-2 font-semibold text-sm whitespace-nowrap " + ("relatorios" === t ? "text-purple-700 border-b-2 border-purple-600 bg-purple-50" : "text-gray-600")
            }, "📈 Relatórios"), React.createElement("button", {
                onClick: async () => {
                    x(e => ({
                        ...e,
                        dispSubTab: "motoboys",
                        motoboysBusca: "",
                        motoboysLojaFiltro: "",
                        motoboysDias: 30,
                        motoboysList: null,
                        motoboysLoading: !0
                    }));
                    try {
                        const e = await fetch(`${API_URL}/disponibilidade/motoboys?dias=30`),
                            t = await e.json();
                        x(e => ({
                            ...e,
                            motoboysList: t,
                            motoboysLoading: !1
                        }))
                    } catch (e) {
                        console.error("Erro ao carregar motoboys:", e), x(e => ({
                            ...e,
                            motoboysLoading: !1
                        }))
                    }
                },
                className: "px-3 py-2 font-semibold text-sm whitespace-nowrap " + ("motoboys" === t ? "text-purple-700 border-b-2 border-purple-600 bg-purple-50" : "text-gray-600")
            }, "🏍️ Motoboys"), React.createElement("button", {
                onClick: async () => {
                    x(e => ({
                        ...e,
                        dispSubTab: "restricoes",
                        restricoesLoading: !0
                    }));
                    try {
                        const e = await fetch(`${API_URL}/disponibilidade/restricoes`),
                            t = await e.json();
                        x(e => ({
                            ...e,
                            restricoesList: t,
                            restricoesLoading: !1
                        }))
                    } catch (e) {
                        console.error("Erro ao carregar restrições:", e), x(e => ({
                            ...e,
                            restricoesLoading: !1
                        }))
                    }
                },
                className: "px-3 py-2 font-semibold text-sm whitespace-nowrap " + ("restricoes" === t ? "text-purple-700 border-b-2 border-purple-600 bg-purple-50" : "text-gray-600")
            }, "🚫 Restrições"), React.createElement("button", {
                onClick: () => x({
                    ...p,
                    dispSubTab: "config"
                }),
                className: "px-3 py-2 font-semibold text-sm whitespace-nowrap " + ("config" === t ? "text-purple-700 border-b-2 border-purple-600 bg-purple-50" : "text-gray-600")
            }, "⚙️ Config"))), "panorama" === t && React.createElement("div", null, React.createElement("div", {
                className: "bg-gray-800 text-white px-2 py-1.5 flex justify-between items-center text-[10px] flex-wrap gap-1"
            }, React.createElement("div", {
                className: "flex items-center gap-2"
            }, React.createElement("span", {
                className: "font-bold"
            }, "PANORAMA DIÁRIO"), (() => {
                const t = e.linhas || [],
                    a = t.filter(e => !e.is_excedente && !e.is_reposicao).length,
                    l = t.filter(e => "EM LOJA" === e.status).length,
                    r = (t.filter(e => ["A CAMINHO", "CONFIRMADO", "EM LOJA"].includes(e.status)).length, Math.max(0, a - l)),
                    o = a > 0 ? Math.min(l / a * 100, 100).toFixed(0) : 0;
                return React.createElement("div", {
                    className: "flex items-center gap-2"
                }, React.createElement("span", {
                    className: "px-2 py-0.5 rounded text-xs font-bold " + (o >= 80 ? "bg-green-500" : o >= 50 ? "bg-yellow-500 text-black" : "bg-red-500")
                }, o, "% GERAL"), r > 0 && React.createElement("span", {
                    className: "px-2 py-0.5 rounded text-xs font-bold bg-red-600 animate-pulse"
                }, "⚠️ FALTAM ", r, " P/ 100%"))
            })()), React.createElement("div", {
                className: "flex items-center gap-1 flex-wrap"
            }, React.createElement("span", {
                className: "text-gray-400 text-[9px]"
            }, "Atualizado: ", (new Date).toLocaleTimeString("pt-BR", {
                hour: "2-digit",
                minute: "2-digit"
            })), React.createElement("select", {
                value: p.panoramaOrdem || "regiao",
                onChange: e => x({
                    ...p,
                    panoramaOrdem: e.target.value
                }),
                className: "px-1 py-0 bg-gray-700 border border-gray-600 rounded text-[9px]"
            }, React.createElement("option", {
                value: "regiao"
            }, "Por Região"), React.createElement("option", {
                value: "pior"
            }, "Pior → Melhor"), React.createElement("option", {
                value: "melhor"
            }, "Melhor → Pior"), React.createElement("option", {
                value: "alfa"
            }, "A → Z")), React.createElement("input", {
                type: "date",
                value: p.dispDataPlanilha || (new Date).toISOString().split("T")[0],
                onChange: e => x({
                    ...p,
                    dispDataPlanilha: e.target.value
                }),
                className: "px-1 py-0 border border-gray-600 rounded text-[10px] text-white bg-gray-700"
            }), React.createElement("button", {
                onClick: r,
                className: "px-1.5 py-0.5 bg-gray-700 text-white rounded hover:bg-gray-600 text-[10px]"
            }, "🔄"), React.createElement("button", {
                onClick: () => {
                    navigator.clipboard.writeText(`${API_URL}/disponibilidade/publico`), ja("✅ Link copiado!", "success")
                },
                className: "px-1.5 py-0.5 bg-blue-600 text-white rounded hover:bg-blue-700 text-[10px]",
                title: "Copiar link público (somente leitura)"
            }, "🔗 Link Público"))), React.createElement("div", {
                className: "overflow-x-auto"
            }, React.createElement("table", {
                id: "panorama-table",
                style: {
                    fontSize: "9px",
                    borderCollapse: "collapse",
                    width: "100%"
                }
            }, React.createElement("thead", null, React.createElement("tr", {
                style: {
                    backgroundColor: "#f8fafc",
                    borderBottom: "2px solid #e2e8f0"
                }
            }, React.createElement("th", {
                style: {
                    padding: "4px 6px",
                    border: "1px solid #e2e8f0",
                    textAlign: "left",
                    fontWeight: "600",
                    color: "#475569"
                }
            }, "LOJAS"), React.createElement("th", {
                style: {
                    padding: "4px 4px",
                    border: "1px solid #e2e8f0",
                    fontWeight: "600",
                    color: "#475569",
                    whiteSpace: "nowrap"
                }
            }, "A CAMINHO"), React.createElement("th", {
                style: {
                    padding: "4px 4px",
                    border: "1px solid #e2e8f0",
                    fontWeight: "600",
                    color: "#475569"
                }
            }, "CONFIR."), React.createElement("th", {
                style: {
                    padding: "4px 4px",
                    border: "1px solid #e2e8f0",
                    fontWeight: "600",
                    color: "#475569",
                    whiteSpace: "nowrap"
                }
            }, "EM LOJA"), React.createElement("th", {
                style: {
                    padding: "4px 4px",
                    border: "1px solid #e2e8f0",
                    fontWeight: "600",
                    color: "#475569"
                }
            }, "IDEAL"), React.createElement("th", {
                style: {
                    padding: "4px 4px",
                    border: "1px solid #e2e8f0",
                    fontWeight: "600",
                    color: "#475569"
                }
            }, "FALTA"), React.createElement("th", {
                style: {
                    padding: "4px 4px",
                    border: "1px solid #e2e8f0",
                    fontWeight: "600",
                    color: "#475569",
                    whiteSpace: "nowrap"
                }
            }, "S/ CONTATO"), React.createElement("th", {
                style: {
                    padding: "4px 4px",
                    border: "1px solid #e2e8f0",
                    fontWeight: "600",
                    color: "#475569"
                }
            }, "%"))), React.createElement("tbody", null, (() => {
                const t = p.panoramaOrdem || "regiao",
                    a = e.regioes || [],
                    l = e.lojas || [],
                    r = e.linhas || [],
                    o = l.map(e => {
                        const t = r.filter(t => t.loja_id === e.id),
                            l = t.filter(e => !e.is_excedente && !e.is_reposicao).length,
                            o = t.filter(e => "A CAMINHO" === e.status).length,
                            c = t.filter(e => "CONFIRMADO" === e.status).length,
                            s = t.filter(e => "EM LOJA" === e.status).length,
                            n = t.filter(e => "SEM CONTATO" === e.status).length,
                            m = o + c + s,
                            i = Math.max(0, l - m),
                            d = l > 0 ? Math.min(s / l * 100, 100) : 0,
                            p = a.find(t => t.id === e.regiao_id);
                        return {
                            ...e,
                            titulares: l,
                            aCaminho: o,
                            confirmado: c,
                            emLoja: s,
                            semContato: n,
                            emOperacao: m,
                            falta: i,
                            perc: d,
                            regiao: p
                        }
                    });
                let c = {
                    aCaminho: 0,
                    confirmado: 0,
                    emLoja: 0,
                    titulares: 0,
                    falta: 0,
                    semContato: 0,
                    emOperacao: 0
                };
                o.forEach(e => {
                    c.aCaminho += e.aCaminho, c.confirmado += e.confirmado, c.emLoja += e.emLoja, c.titulares += e.titulares, c.falta += e.falta, c.semContato += e.semContato, c.emOperacao += e.emOperacao
                });
                const s = c.titulares > 0 ? Math.min(c.emLoja / c.titulares * 100, 100) : 0;
                return "pior" === t ? o.sort((e, t) => e.perc - t.perc) : "melhor" === t ? o.sort((e, t) => t.perc - e.perc) : "alfa" === t && o.sort((e, t) => e.nome.localeCompare(t.nome)), "regiao" === t ? React.createElement(React.Fragment, null, a.map(e => {
                    const t = o.filter(t => t.regiao_id === e.id);
                    return 0 === t.length ? null : React.createElement(React.Fragment, {
                        key: e.id
                    }, React.createElement("tr", null, React.createElement("td", {
                        colSpan: "8",
                        style: {
                            padding: "4px 6px",
                            border: "1px solid #cbd5e1",
                            backgroundColor: "#e2e8f0",
                            fontWeight: "700",
                            color: "#1e293b",
                            fontSize: "9px",
                            textAlign: "center"
                        }
                    }, e.nome, e.gestores ? ` (${e.gestores})` : "")), t.map(e => React.createElement("tr", {
                        key: e.id,
                        style: {
                            backgroundColor: e.perc < 50 ? "#fef2f2" : "white"
                        }
                    }, React.createElement("td", {
                        style: {
                            padding: "2px 6px",
                            border: "1px solid #e2e8f0",
                            backgroundColor: e.perc < 50 ? "#fef2f2" : "#fafafa",
                            fontWeight: "500",
                            whiteSpace: "nowrap"
                        }
                    }, e.perc < 50 && React.createElement("span", {
                        style: {
                            color: "#ef4444",
                            marginRight: "2px"
                        }
                    }, "🔴"), e.nome), React.createElement("td", {
                        style: {
                            padding: "2px 4px",
                            border: "1px solid #e2e8f0",
                            textAlign: "center",
                            fontWeight: "500",
                            color: e.aCaminho > 0 ? "#ea580c" : "#cbd5e1"
                        }
                    }, e.aCaminho), React.createElement("td", {
                        style: {
                            padding: "2px 4px",
                            border: "1px solid #e2e8f0",
                            textAlign: "center",
                            fontWeight: "500",
                            color: e.confirmado > 0 ? "#16a34a" : "#cbd5e1"
                        }
                    }, e.confirmado), React.createElement("td", {
                        style: {
                            padding: "2px 4px",
                            border: "1px solid #e2e8f0",
                            textAlign: "center",
                            fontWeight: "700",
                            color: e.emLoja > 0 ? "#2563eb" : "#cbd5e1"
                        }
                    }, e.emLoja), React.createElement("td", {
                        style: {
                            padding: "2px 4px",
                            border: "1px solid #e2e8f0",
                            textAlign: "center",
                            fontWeight: "500",
                            color: "#64748b"
                        }
                    }, e.titulares), React.createElement("td", {
                        style: {
                            padding: "2px 4px",
                            border: "1px solid #e2e8f0",
                            textAlign: "center",
                            fontWeight: "600",
                            color: e.falta > 0 ? "#dc2626" : "#cbd5e1"
                        }
                    }, e.falta > 0 ? -e.falta : 0), React.createElement("td", {
                        style: {
                            padding: "2px 4px",
                            border: "1px solid #e2e8f0",
                            textAlign: "center",
                            fontWeight: "500",
                            color: e.semContato > 0 ? "#d97706" : "#cbd5e1"
                        }
                    }, e.semContato), React.createElement("td", {
                        style: {
                            padding: "2px 4px",
                            border: "1px solid #e2e8f0",
                            textAlign: "center",
                            fontWeight: "700",
                            backgroundColor: e.perc < 50 ? "#fecaca" : e.perc < 80 ? "#fde68a" : e.perc >= 100 ? "#bbf7d0" : "#f1f5f9",
                            color: e.perc < 50 ? "#b91c1c" : e.perc < 80 ? "#a16207" : e.perc >= 100 ? "#15803d" : "#475569"
                        }
                    }, e.perc.toFixed(0), "%"))))
                }), React.createElement("tr", {
                    style: {
                        backgroundColor: "#f8fafc",
                        borderTop: "2px solid #cbd5e1"
                    }
                }, React.createElement("td", {
                    style: {
                        padding: "4px 6px",
                        border: "1px solid #e2e8f0",
                        fontWeight: "700",
                        fontSize: "9px",
                        color: "#1e293b"
                    }
                }, "TOTAL GERAL"), React.createElement("td", {
                    style: {
                        padding: "3px 4px",
                        border: "1px solid #e2e8f0",
                        textAlign: "center",
                        fontWeight: "600",
                        color: "#ea580c"
                    }
                }, c.aCaminho), React.createElement("td", {
                    style: {
                        padding: "3px 4px",
                        border: "1px solid #e2e8f0",
                        textAlign: "center",
                        fontWeight: "600",
                        color: "#16a34a"
                    }
                }, c.confirmado), React.createElement("td", {
                    style: {
                        padding: "3px 4px",
                        border: "1px solid #e2e8f0",
                        textAlign: "center",
                        fontWeight: "600",
                        color: "#2563eb"
                    }
                }, c.emLoja), React.createElement("td", {
                    style: {
                        padding: "3px 4px",
                        border: "1px solid #e2e8f0",
                        textAlign: "center",
                        fontWeight: "600",
                        color: "#64748b"
                    }
                }, c.titulares), React.createElement("td", {
                    style: {
                        padding: "3px 4px",
                        border: "1px solid #e2e8f0",
                        textAlign: "center",
                        fontWeight: "700",
                        color: c.falta > 0 ? "#dc2626" : "#cbd5e1"
                    }
                }, c.falta > 0 ? -c.falta : 0), React.createElement("td", {
                    style: {
                        padding: "3px 4px",
                        border: "1px solid #e2e8f0",
                        textAlign: "center",
                        fontWeight: "600",
                        color: c.semContato > 0 ? "#d97706" : "#cbd5e1"
                    }
                }, c.semContato), React.createElement("td", {
                    style: {
                        padding: "3px 4px",
                        border: "1px solid #e2e8f0",
                        textAlign: "center",
                        fontWeight: "800",
                        backgroundColor: s < 50 ? "#fecaca" : s < 80 ? "#fde68a" : s >= 100 ? "#bbf7d0" : "#f1f5f9",
                        color: s < 50 ? "#b91c1c" : s < 80 ? "#a16207" : s >= 100 ? "#15803d" : "#475569"
                    }
                }, s.toFixed(0), "%"))) : React.createElement(React.Fragment, null, o.map((e, t) => React.createElement("tr", {
                    key: e.id,
                    style: {
                        backgroundColor: e.perc < 50 ? "#fef2f2" : "white"
                    }
                }, React.createElement("td", {
                    style: {
                        padding: "2px 6px",
                        border: "1px solid #e2e8f0",
                        backgroundColor: e.perc < 50 ? "#fef2f2" : "#fafafa",
                        fontWeight: "500",
                        whiteSpace: "nowrap"
                    }
                }, React.createElement("span", {
                    style: {
                        color: "#94a3b8",
                        fontSize: "8px",
                        marginRight: "3px"
                    }
                }, t + 1, "."), e.perc < 50 && React.createElement("span", {
                    style: {
                        color: "#ef4444",
                        marginRight: "2px"
                    }
                }, "🔴"), e.nome, React.createElement("span", {
                    style: {
                        color: "#94a3b8",
                        fontSize: "7px",
                        marginLeft: "3px"
                    }
                }, "(", e.regiao?.nome || "", ")")), React.createElement("td", {
                    style: {
                        padding: "2px 4px",
                        border: "1px solid #e2e8f0",
                        textAlign: "center",
                        fontWeight: "500",
                        color: e.aCaminho > 0 ? "#ea580c" : "#cbd5e1"
                    }
                }, e.aCaminho), React.createElement("td", {
                    style: {
                        padding: "2px 4px",
                        border: "1px solid #e2e8f0",
                        textAlign: "center",
                        fontWeight: "500",
                        color: e.confirmado > 0 ? "#16a34a" : "#cbd5e1"
                    }
                }, e.confirmado), React.createElement("td", {
                    style: {
                        padding: "2px 4px",
                        border: "1px solid #e2e8f0",
                        textAlign: "center",
                        fontWeight: "700",
                        color: e.emLoja > 0 ? "#2563eb" : "#cbd5e1"
                    }
                }, e.emLoja), React.createElement("td", {
                    style: {
                        padding: "2px 4px",
                        border: "1px solid #e2e8f0",
                        textAlign: "center",
                        fontWeight: "500",
                        color: "#64748b"
                    }
                }, e.titulares), React.createElement("td", {
                    style: {
                        padding: "2px 4px",
                        border: "1px solid #e2e8f0",
                        textAlign: "center",
                        fontWeight: "600",
                        color: e.falta > 0 ? "#dc2626" : "#cbd5e1"
                    }
                }, e.falta > 0 ? -e.falta : 0), React.createElement("td", {
                    style: {
                        padding: "2px 4px",
                        border: "1px solid #e2e8f0",
                        textAlign: "center",
                        fontWeight: "500",
                        color: e.semContato > 0 ? "#d97706" : "#cbd5e1"
                    }
                }, e.semContato), React.createElement("td", {
                    style: {
                        padding: "2px 4px",
                        border: "1px solid #e2e8f0",
                        textAlign: "center",
                        fontWeight: "700",
                        backgroundColor: e.perc < 50 ? "#fecaca" : e.perc < 80 ? "#fde68a" : e.perc >= 100 ? "#bbf7d0" : "#f1f5f9",
                        color: e.perc < 50 ? "#b91c1c" : e.perc < 80 ? "#a16207" : e.perc >= 100 ? "#15803d" : "#475569"
                    }
                }, e.perc.toFixed(0), "%"))), React.createElement("tr", {
                    style: {
                        backgroundColor: "#f8fafc",
                        borderTop: "2px solid #cbd5e1"
                    }
                }, React.createElement("td", {
                    style: {
                        padding: "4px 6px",
                        border: "1px solid #e2e8f0",
                        fontWeight: "700",
                        fontSize: "9px",
                        color: "#1e293b"
                    }
                }, "TOTAL GERAL"), React.createElement("td", {
                    style: {
                        padding: "3px 4px",
                        border: "1px solid #e2e8f0",
                        textAlign: "center",
                        fontWeight: "600",
                        color: "#ea580c"
                    }
                }, c.aCaminho), React.createElement("td", {
                    style: {
                        padding: "3px 4px",
                        border: "1px solid #e2e8f0",
                        textAlign: "center",
                        fontWeight: "600",
                        color: "#16a34a"
                    }
                }, c.confirmado), React.createElement("td", {
                    style: {
                        padding: "3px 4px",
                        border: "1px solid #e2e8f0",
                        textAlign: "center",
                        fontWeight: "600",
                        color: "#2563eb"
                    }
                }, c.emLoja), React.createElement("td", {
                    style: {
                        padding: "3px 4px",
                        border: "1px solid #e2e8f0",
                        textAlign: "center",
                        fontWeight: "600",
                        color: "#64748b"
                    }
                }, c.titulares), React.createElement("td", {
                    style: {
                        padding: "3px 4px",
                        border: "1px solid #e2e8f0",
                        textAlign: "center",
                        fontWeight: "700",
                        color: c.falta > 0 ? "#dc2626" : "#cbd5e1"
                    }
                }, c.falta > 0 ? -c.falta : 0), React.createElement("td", {
                    style: {
                        padding: "3px 4px",
                        border: "1px solid #e2e8f0",
                        textAlign: "center",
                        fontWeight: "600",
                        color: c.semContato > 0 ? "#d97706" : "#cbd5e1"
                    }
                }, c.semContato), React.createElement("td", {
                    style: {
                        padding: "3px 4px",
                        border: "1px solid #e2e8f0",
                        textAlign: "center",
                        fontWeight: "800",
                        backgroundColor: s < 50 ? "#fecaca" : s < 80 ? "#fde68a" : s >= 100 ? "#bbf7d0" : "#f1f5f9",
                        color: s < 50 ? "#b91c1c" : s < 80 ? "#a16207" : s >= 100 ? "#15803d" : "#475569"
                    }
                }, s.toFixed(0), "%")))
            })())))), "relatorios" === t && React.createElement("div", {
                className: "space-y-4"
            }, p.relatoriosLoading ? React.createElement("div", {
                className: "flex items-center justify-center py-12"
            }, React.createElement("div", {
                className: "text-center"
            }, React.createElement("div", {
                className: "animate-spin rounded-full h-12 w-12 border-b-2 border-purple-600 mx-auto"
            }), React.createElement("p", {
                className: "mt-4 text-gray-600"
            }, "Carregando relatórios..."))) : React.createElement(React.Fragment, null, React.createElement("div", {
                className: "bg-white rounded-xl shadow p-4"
            }, React.createElement("h3", {
                className: "font-bold text-gray-800 mb-3"
            }, "📊 Comparativo"), React.createElement("div", {
                className: "grid grid-cols-3 gap-4"
            }, [{
                key: "hoje",
                data: p.relatoriosData?.comparativo?.hoje,
                color: "blue"
            }, {
                key: "ontem",
                data: p.relatoriosData?.comparativo?.ontem,
                color: "gray"
            }, {
                key: "semanaPassada",
                data: p.relatoriosData?.comparativo?.semanaPassada,
                color: "purple"
            }].map(e => {
                const t = (p.relatoriosData?.comparativo?.labels || {})[e.key] || ("hoje" === e.key ? "MAIS RECENTE" : "ontem" === e.key ? "ANTERIOR" : "3º ANTERIOR");
                return React.createElement("div", {
                    key: e.key,
                    className: `p-4 rounded-lg bg-${e.color}-50 border border-${e.color}-200`
                }, React.createElement("h4", {
                    className: `font-bold text-${e.color}-800 text-center mb-2`
                }, t), e.data ? React.createElement("div", {
                    className: "space-y-1 text-sm"
                }, React.createElement("div", {
                    className: "flex justify-between"
                }, React.createElement("span", null, "% EM LOJA:"), React.createElement("span", {
                    className: "font-bold " + (e.data.perc >= 80 ? "text-green-600" : e.data.perc >= 50 ? "text-yellow-600" : "text-red-600")
                }, e.data.perc, "%")), React.createElement("div", {
                    className: "flex justify-between"
                }, React.createElement("span", null, "Em Loja:"), React.createElement("span", {
                    className: "font-bold text-blue-600"
                }, e.data.emLoja || 0)), React.createElement("div", {
                    className: "flex justify-between"
                }, React.createElement("span", null, "Titulares:"), React.createElement("span", {
                    className: "font-bold"
                }, e.data.titulares || 0)), React.createElement("div", {
                    className: "flex justify-between"
                }, React.createElement("span", null, "Faltando:"), React.createElement("span", {
                    className: "font-bold text-red-600"
                }, e.data.faltando || 0)), React.createElement("div", {
                    className: "flex justify-between"
                }, React.createElement("span", null, "Sem Contato:"), React.createElement("span", {
                    className: "font-bold text-orange-600"
                }, e.data.semContato || 0))) : React.createElement("p", {
                    className: "text-gray-400 text-center text-sm"
                }, "Sem dados"))
            })), p.relatoriosData?.comparativo?.hoje && p.relatoriosData?.comparativo?.ontem && React.createElement("div", {
                className: "mt-3 flex justify-center gap-4 text-sm"
            }, React.createElement("span", {
                className: "px-3 py-1 rounded-full bg-gray-100"
            }, "vs Ontem:", React.createElement("span", {
                className: "ml-1 font-bold " + (p.relatoriosData.comparativo.hoje.perc - p.relatoriosData.comparativo.ontem.perc >= 0 ? "text-green-600" : "text-red-600")
            }, p.relatoriosData.comparativo.hoje.perc - p.relatoriosData.comparativo.ontem.perc >= 0 ? "+" : "", (p.relatoriosData.comparativo.hoje.perc - p.relatoriosData.comparativo.ontem.perc).toFixed(1), "%")), p.relatoriosData?.comparativo?.semanaPassada && React.createElement("span", {
                className: "px-3 py-1 rounded-full bg-gray-100"
            }, "vs Semana:", React.createElement("span", {
                className: "ml-1 font-bold " + (p.relatoriosData.comparativo.hoje.perc - p.relatoriosData.comparativo.semanaPassada.perc >= 0 ? "text-green-600" : "text-red-600")
            }, p.relatoriosData.comparativo.hoje.perc - p.relatoriosData.comparativo.semanaPassada.perc >= 0 ? "+" : "", (p.relatoriosData.comparativo.hoje.perc - p.relatoriosData.comparativo.semanaPassada.perc).toFixed(1), "%")))), React.createElement("div", {
                className: "bg-white rounded-xl shadow p-4"
            }, React.createElement("h3", {
                className: "font-bold text-gray-800 mb-3"
            }, "📈 Evolução % EM LOJA (7 dias)"), (() => {
                const e = Array.isArray(p.relatoriosData?.metricas) ? p.relatoriosData.metricas : [];
                return 0 === e.length ? React.createElement("p", {
                    className: "text-gray-400 text-center py-8"
                }, "Sem dados históricos. Salve espelhos diários para ver o gráfico.") : React.createElement("div", {
                    className: "h-48 flex items-end gap-2 justify-around bg-gray-50 rounded-lg p-4"
                }, e.slice(0, 7).reverse().map((e, t) => {
                    let a = "-";
                    if (e.data) {
                        const t = e.data.split("T")[0],
                            [l, r, o] = t.split("-");
                        a = `${o}/${r}`
                    }
                    const l = e.percOperacao || 0,
                        r = Math.max(10, l);
                    return React.createElement("div", {
                        key: t,
                        className: "flex flex-col items-center flex-1"
                    }, React.createElement("span", {
                        className: "text-xs font-bold mb-1"
                    }, l, "%"), React.createElement("div", {
                        className: "w-full rounded-t-lg transition-all " + (l >= 80 ? "bg-green-500" : l >= 50 ? "bg-yellow-500" : "bg-red-500"),
                        style: {
                            height: 1.5 * r + "px",
                            maxHeight: "140px"
                        }
                    }), React.createElement("span", {
                        className: "text-[10px] text-gray-500 mt-1"
                    }, a), React.createElement("span", {
                        className: "text-[9px] text-blue-600"
                    }, e.emLoja || 0, " em loja"))
                }))
            })()), React.createElement("div", {
                className: "grid grid-cols-1 md:grid-cols-2 gap-4"
            }, React.createElement("div", {
                className: "bg-white rounded-xl shadow p-4"
            }, React.createElement("h3", {
                className: "font-bold text-gray-800 mb-3"
            }, "🏆 Ranking de Lojas (7 dias)"), React.createElement("div", {
                className: "space-y-1 max-h-64 overflow-y-auto"
            }, (() => {
                const e = Array.isArray(p.relatoriosData?.rankingLojas) ? p.relatoriosData.rankingLojas : [];
                return 0 === e.length ? React.createElement("p", {
                    className: "text-gray-400 text-center py-4"
                }, "Sem dados de lojas") : React.createElement(React.Fragment, null, React.createElement("p", {
                    className: "text-xs font-semibold text-green-700 mb-1"
                }, "✅ TOP 5 MELHORES"), e.slice(0, 5).map((e, t) => React.createElement("div", {
                    key: e.loja_id || t,
                    className: "flex items-center gap-2 p-1.5 bg-green-50 rounded text-xs"
                }, React.createElement("span", {
                    className: "font-bold text-green-700 w-5"
                }, t + 1, "º"), React.createElement("span", {
                    className: "flex-1 truncate"
                }, e.loja_nome || "-"), React.createElement("span", {
                    className: "text-gray-500 text-[10px]"
                }, e.regiao_nome || ""), React.createElement("span", {
                    className: "font-bold text-green-700"
                }, e.mediaPerc || 0, "%"))), e.length > 5 && React.createElement(React.Fragment, null, React.createElement("p", {
                    className: "text-xs font-semibold text-red-700 mt-3 mb-1"
                }, "⚠️ TOP 5 PIORES"), e.slice(-5).reverse().map((t, a) => React.createElement("div", {
                    key: `worst-${t.loja_id||a}`,
                    className: "flex items-center gap-2 p-1.5 bg-red-50 rounded text-xs"
                }, React.createElement("span", {
                    className: "font-bold text-red-700 w-5"
                }, e.length - 4 + a, "º"), React.createElement("span", {
                    className: "flex-1 truncate"
                }, t.loja_nome || "-"), React.createElement("span", {
                    className: "text-gray-500 text-[10px]"
                }, t.regiao_nome || ""), React.createElement("span", {
                    className: "font-bold text-red-700"
                }, t.mediaPerc || 0, "%")))))
            })())), React.createElement("div", {
                className: "bg-white rounded-xl shadow p-4"
            }, React.createElement("h3", {
                className: "font-bold text-gray-800 mb-3"
            }, "🚫 Ranking de Faltosos (30 dias)"), React.createElement("div", {
                className: "space-y-1 max-h-64 overflow-y-auto"
            }, (() => {
                const e = Array.isArray(p.relatoriosData?.rankingFaltosos) ? p.relatoriosData.rankingFaltosos : [];
                return 0 === e.length ? React.createElement("p", {
                    className: "text-gray-400 text-center py-4"
                }, "Nenhuma falta registrada") : e.slice(0, 10).map((e, t) => React.createElement("div", {
                    key: e.cod || e.nome || t,
                    className: "flex items-center gap-2 p-1.5 bg-red-50 rounded text-xs"
                }, React.createElement("span", {
                    className: "font-bold text-red-700 w-5"
                }, t + 1, "º"), React.createElement("span", {
                    className: "font-mono text-gray-600 w-12"
                }, e.cod || "-"), React.createElement("span", {
                    className: "flex-1 truncate"
                }, e.nome || "Sem nome"), React.createElement("span", {
                    className: "text-gray-500 text-[10px] truncate max-w-20"
                }, e.loja_nome || ""), React.createElement("span", {
                    className: "font-bold text-red-700 bg-red-200 px-1.5 rounded"
                }, e.totalFaltas || 0, "x")))
            })()))), React.createElement("div", {
                className: "bg-white rounded-xl shadow p-4"
            }, React.createElement("h3", {
                className: "font-bold text-gray-800 mb-3"
            }, "🔥 Heatmap de Faltas por Dia da Semana (30 dias)"), (() => {
                const e = p.relatoriosData?.heatmap || {},
                    t = Array.isArray(e.lojas) ? e.lojas : [],
                    a = Array.isArray(e.diasSemana) ? e.diasSemana : ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
                return 0 === t.length ? React.createElement("p", {
                    className: "text-gray-400 text-center py-4"
                }, "Sem dados de faltas para gerar heatmap") : React.createElement("div", {
                    className: "overflow-x-auto"
                }, React.createElement("table", {
                    className: "w-full text-xs"
                }, React.createElement("thead", null, React.createElement("tr", {
                    className: "bg-gray-100"
                }, React.createElement("th", {
                    className: "px-2 py-1 text-left"
                }, "Loja"), a.map((e, t) => React.createElement("th", {
                    key: t,
                    className: "px-2 py-1 text-center w-12"
                }, e)), React.createElement("th", {
                    className: "px-2 py-1 text-center"
                }, "Total"))), React.createElement("tbody", null, t.slice(0, 15).map((e, t) => {
                    const a = Array.isArray(e.dias) ? e.dias : [0, 0, 0, 0, 0, 0, 0],
                        l = a.reduce((e, t) => e + t, 0),
                        r = Math.max(...a, 1);
                    return React.createElement("tr", {
                        key: e.loja_nome || t,
                        className: "border-t"
                    }, React.createElement("td", {
                        className: "px-2 py-1 font-medium truncate max-w-32"
                    }, e.loja_nome || "-"), a.map((e, t) => {
                        const a = e / r,
                            l = 0 === e ? "bg-gray-50" : a >= .8 ? "bg-red-500 text-white" : a >= .5 ? "bg-orange-400 text-white" : a >= .3 ? "bg-yellow-300" : "bg-yellow-100";
                        return React.createElement("td", {
                            key: t,
                            className: `px-2 py-1 text-center font-bold ${l}`
                        }, e || "-")
                    }), React.createElement("td", {
                        className: "px-2 py-1 text-center font-bold bg-gray-200"
                    }, l))
                }))))
            })(), React.createElement("div", {
                className: "flex justify-center gap-2 mt-3 text-[10px]"
            }, React.createElement("span", {
                className: "px-2 py-0.5 bg-gray-50 rounded"
            }, "0"), React.createElement("span", {
                className: "px-2 py-0.5 bg-yellow-100 rounded"
            }, "Baixo"), React.createElement("span", {
                className: "px-2 py-0.5 bg-yellow-300 rounded"
            }, "Médio"), React.createElement("span", {
                className: "px-2 py-0.5 bg-orange-400 text-white rounded"
            }, "Alto"), React.createElement("span", {
                className: "px-2 py-0.5 bg-red-500 text-white rounded"
            }, "Crítico"))))), "motoboys" === t && React.createElement("div", {
                className: "space-y-4"
            }, React.createElement("div", {
                className: "bg-white rounded-xl shadow p-4"
            }, React.createElement("h3", {
                className: "font-bold text-gray-800 mb-4"
            }, "🏍️ Histórico de Motoboys"), React.createElement("div", {
                className: "flex flex-wrap gap-3 mb-4"
            }, React.createElement("div", {
                className: "flex-1 min-w-[200px]"
            }, React.createElement("input", {
                type: "text",
                placeholder: "🔍 Buscar por código ou nome...",
                value: p.motoboysBusca || "",
                onChange: e => x(t => ({
                    ...t,
                    motoboysBusca: e.target.value
                })),
                className: "w-full px-3 py-2 border rounded-lg text-sm"
            })), React.createElement("select", {
                value: p.motoboysLojaFiltro || "",
                onChange: e => x(t => ({
                    ...t,
                    motoboysLojaFiltro: e.target.value
                })),
                className: "px-3 py-2 border rounded-lg text-sm"
            }, React.createElement("option", {
                value: ""
            }, "📍 Todas as Lojas"), (e.lojas || []).map(e => React.createElement("option", {
                key: e.id,
                value: e.id
            }, e.codigo, " - ", e.nome))), React.createElement("select", {
                value: p.motoboysDias || 30,
                onChange: e => x(t => ({
                    ...t,
                    motoboysDias: parseInt(e.target.value)
                })),
                className: "px-3 py-2 border rounded-lg text-sm"
            }, React.createElement("option", {
                value: 7
            }, "Últimos 7 dias"), React.createElement("option", {
                value: 15
            }, "Últimos 15 dias"), React.createElement("option", {
                value: 30
            }, "Últimos 30 dias"), React.createElement("option", {
                value: 60
            }, "Últimos 60 dias"), React.createElement("option", {
                value: 90
            }, "Últimos 90 dias")), React.createElement("button", {
                onClick: async () => {
                    x(e => ({
                        ...e,
                        motoboysLoading: !0
                    }));
                    try {
                        const e = new URLSearchParams;
                        e.append("dias", p.motoboysDias || 30), p.motoboysLojaFiltro && e.append("loja_id", p.motoboysLojaFiltro), p.motoboysBusca && e.append("busca", p.motoboysBusca);
                        const t = await fetch(`${API_URL}/disponibilidade/motoboys?${e}`),
                            a = await t.json();
                        x(e => ({
                            ...e,
                            motoboysList: a,
                            motoboysLoading: !1
                        }))
                    } catch (e) {
                        console.error("Erro ao buscar motoboys:", e), ja("Erro ao buscar motoboys", "error"), x(e => ({
                            ...e,
                            motoboysLoading: !1
                        }))
                    }
                },
                className: "px-4 py-2 bg-purple-600 text-white rounded-lg font-semibold hover:bg-purple-700"
            }, "🔍 Buscar")), p.motoboysLoading && React.createElement("div", {
                className: "flex items-center justify-center py-8"
            }, React.createElement("div", {
                className: "animate-spin rounded-full h-8 w-8 border-b-2 border-purple-600"
            }), React.createElement("span", {
                className: "ml-3 text-gray-600"
            }, "Carregando...")), !p.motoboysLoading && p.motoboysList && React.createElement("div", null, React.createElement("div", {
                className: "mb-4 p-3 bg-gray-100 rounded-lg flex items-center justify-between"
            }, React.createElement("span", {
                className: "text-sm text-gray-700"
            }, React.createElement("strong", null, p.motoboysList.total || 0), " motoboys encontrados (últimos ", React.createElement("strong", null, p.motoboysList.periodo_dias), " dias)")), React.createElement("div", {
                className: "overflow-x-auto"
            }, React.createElement("table", {
                className: "w-full text-xs border-collapse"
            }, React.createElement("thead", null, React.createElement("tr", {
                className: "bg-gray-800 text-white"
            }, React.createElement("th", {
                className: "px-2 py-2 text-left"
            }, "COD"), React.createElement("th", {
                className: "px-2 py-2 text-left"
            }, "NOME"), React.createElement("th", {
                className: "px-2 py-2 text-left"
            }, "LOJA ATUAL"), React.createElement("th", {
                className: "px-2 py-2 text-center bg-green-700"
            }, "🏪 EM LOJA"), React.createElement("th", {
                className: "px-2 py-2 text-center bg-red-700"
            }, "❌ FALTAS"), React.createElement("th", {
                className: "px-2 py-2 text-center bg-orange-600"
            }, "📵 S/ CONTATO"), React.createElement("th", {
                className: "px-2 py-2 text-left"
            }, "LOJAS ONDE RODOU"))), React.createElement("tbody", null, (p.motoboysList.motoboys || []).map((e, t) => React.createElement("tr", {
                key: e.cod,
                className: `border-b ${t%2==0?"bg-white":"bg-gray-50"} hover:bg-blue-50`
            }, React.createElement("td", {
                className: "px-2 py-2 font-mono font-bold text-purple-700"
            }, e.cod), React.createElement("td", {
                className: "px-2 py-2 font-semibold"
            }, e.nome || "-"), React.createElement("td", {
                className: "px-2 py-2"
            }, e.loja_atual ? React.createElement("span", {
                className: "text-gray-700"
            }, React.createElement("span", {
                className: "font-semibold"
            }, e.loja_atual.codigo), " - ", e.loja_atual.nome, e.loja_atual.regiao_nome && React.createElement("span", {
                className: "text-gray-400 text-[10px] ml-1"
            }, "(", e.loja_atual.regiao_nome, ")")) : "-"), React.createElement("td", {
                className: "px-2 py-2 text-center"
            }, React.createElement("span", {
                className: "font-bold " + (e.estatisticas.em_loja.total > 0 ? "text-green-600" : "text-gray-400")
            }, e.estatisticas.em_loja.total, "x"), e.estatisticas.em_loja.ultima_vez && React.createElement("span", {
                className: "text-[9px] text-gray-400 block"
            }, "últ: ", new Date(e.estatisticas.em_loja.ultima_vez).toLocaleDateString("pt-BR", {
                day: "2-digit",
                month: "2-digit"
            }))), React.createElement("td", {
                className: "px-2 py-2 text-center"
            }, React.createElement("span", {
                className: "font-bold " + (e.estatisticas.faltas.total > 0 ? "text-red-600" : "text-gray-400")
            }, e.estatisticas.faltas.total, "x"), e.estatisticas.faltas.ultima_falta && React.createElement("span", {
                className: "text-[9px] text-gray-400 block"
            }, "últ: ", new Date(e.estatisticas.faltas.ultima_falta).toLocaleDateString("pt-BR", {
                day: "2-digit",
                month: "2-digit"
            }))), React.createElement("td", {
                className: "px-2 py-2 text-center"
            }, React.createElement("span", {
                className: "font-bold " + (e.estatisticas.sem_contato.total > 0 ? "text-orange-600" : "text-gray-400")
            }, e.estatisticas.sem_contato.total, "x"), e.estatisticas.sem_contato.max_dias_consecutivos > 0 && React.createElement("span", {
                className: "text-[9px] text-orange-500 block"
            }, "máx: ", e.estatisticas.sem_contato.max_dias_consecutivos, " dias seg.")), React.createElement("td", {
                className: "px-2 py-2"
            }, e.lojas_rodou && e.lojas_rodou.length > 0 ? React.createElement("div", {
                className: "flex flex-wrap gap-1"
            }, e.lojas_rodou.slice(0, 3).map(e => React.createElement("span", {
                key: e.id,
                className: "px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded text-[10px]"
            }, e.codigo)), e.lojas_rodou.length > 3 && React.createElement("span", {
                className: "px-1.5 py-0.5 bg-gray-200 text-gray-600 rounded text-[10px]"
            }, "+", e.lojas_rodou.length - 3)) : React.createElement("span", {
                className: "text-gray-400"
            }, "-"))))))), (!p.motoboysList.motoboys || 0 === p.motoboysList.motoboys.length) && React.createElement("div", {
                className: "text-center py-8 text-gray-500"
            }, React.createElement("p", {
                className: "text-4xl mb-2"
            }, "🏍️"), React.createElement("p", null, "Nenhum motoboy encontrado com os filtros selecionados."))), !p.motoboysLoading && !p.motoboysList && React.createElement("div", {
                className: "text-center py-8 text-gray-500"
            }, React.createElement("p", {
                className: "text-4xl mb-2"
            }, "🔍"), React.createElement("p", null, 'Use os filtros acima e clique em "Buscar" para ver o histórico dos motoboys.'))), React.createElement("div", {
                className: "bg-white rounded-xl shadow p-4"
            }, React.createElement("h4", {
                className: "font-semibold text-gray-700 mb-2 text-sm"
            }, "📊 Legenda das Estatísticas"), React.createElement("div", {
                className: "grid grid-cols-1 md:grid-cols-3 gap-3 text-xs"
            }, React.createElement("div", {
                className: "flex items-center gap-2"
            }, React.createElement("span", {
                className: "w-3 h-3 bg-green-500 rounded"
            }), React.createElement("span", null, React.createElement("strong", null, "EM LOJA:"), ' Quantas vezes recebeu status "EM LOJA" (trabalhou)')), React.createElement("div", {
                className: "flex items-center gap-2"
            }, React.createElement("span", {
                className: "w-3 h-3 bg-red-500 rounded"
            }), React.createElement("span", null, React.createElement("strong", null, "FALTAS:"), ' Quantas vezes foi marcado como "FALTANDO"')), React.createElement("div", {
                className: "flex items-center gap-2"
            }, React.createElement("span", {
                className: "w-3 h-3 bg-orange-500 rounded"
            }), React.createElement("span", null, React.createElement("strong", null, "S/ CONTATO:"), ' Quantas vezes ficou "SEM CONTATO"'))))), "restricoes" === t && React.createElement("div", {
                className: "space-y-4"
            }, React.createElement("div", {
                className: "bg-white rounded-xl shadow p-4"
            }, React.createElement("h3", {
                className: "font-bold text-gray-800 mb-4"
            }, "🚫 Cadastrar Nova Restrição"), React.createElement("div", {
                className: "grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-4"
            }, React.createElement("div", null, React.createElement("label", {
                className: "block text-sm font-semibold text-gray-700 mb-1"
            }, "Código *"), React.createElement("input", {
                type: "text",
                placeholder: "Ex: 12345",
                value: p.restricaoCod || "",
                onChange: e => {
                    const t = e.target.value;
                    x(e => ({
                        ...e,
                        restricaoCod: t
                    }));
                    const a = pe.find(e => e.codigo === t);
                    a && x(e => ({
                        ...e,
                        restricaoNome: a.nome
                    }))
                },
                className: "w-full px-3 py-2 border rounded-lg text-sm"
            })), React.createElement("div", null, React.createElement("label", {
                className: "block text-sm font-semibold text-gray-700 mb-1"
            }, "Nome"), React.createElement("input", {
                type: "text",
                placeholder: "Auto-preenchido",
                value: p.restricaoNome || "",
                onChange: e => x(t => ({
                    ...t,
                    restricaoNome: e.target.value
                })),
                className: "w-full px-3 py-2 border rounded-lg text-sm bg-gray-50"
            })), React.createElement("div", null, React.createElement("label", {
                className: "block text-sm font-semibold text-gray-700 mb-1"
            }, "Loja"), React.createElement("select", {
                value: p.restricaoTodasLojas ? "TODAS" : p.restricaoLojaId || "",
                onChange: e => {
                    "TODAS" === e.target.value ? x(e => ({
                        ...e,
                        restricaoTodasLojas: !0,
                        restricaoLojaId: ""
                    })) : x(t => ({
                        ...t,
                        restricaoTodasLojas: !1,
                        restricaoLojaId: e.target.value
                    }))
                },
                className: "w-full px-3 py-2 border rounded-lg text-sm"
            }, React.createElement("option", {
                value: ""
            }, "Selecione uma loja..."), React.createElement("option", {
                value: "TODAS",
                className: "font-bold text-red-600"
            }, "🚫 TODAS AS LOJAS"), (e.lojas || []).map(e => React.createElement("option", {
                key: e.id,
                value: e.id
            }, e.codigo, " - ", e.nome)))), React.createElement("div", null, React.createElement("label", {
                className: "block text-sm font-semibold text-gray-700 mb-1"
            }, "Motivo *"), React.createElement("input", {
                type: "text",
                placeholder: "Ex: Comportamento inadequado",
                value: p.restricaoMotivo || "",
                onChange: e => x(t => ({
                    ...t,
                    restricaoMotivo: e.target.value
                })),
                className: "w-full px-3 py-2 border rounded-lg text-sm"
            }))), React.createElement("button", {
                onClick: async () => {
                    if (p.restricaoCod && p.restricaoMotivo)
                        if (p.restricaoTodasLojas || p.restricaoLojaId) try {
                            const e = await fetch(`${API_URL}/disponibilidade/restricoes`, {
                                method: "POST",
                                headers: {
                                    "Content-Type": "application/json"
                                },
                                body: JSON.stringify({
                                    cod_profissional: p.restricaoCod,
                                    nome_profissional: p.restricaoNome,
                                    loja_id: p.restricaoLojaId || null,
                                    todas_lojas: p.restricaoTodasLojas || !1,
                                    motivo: p.restricaoMotivo,
                                    criado_por: l?.fullName || l?.username
                                })
                            });
                            if (!e.ok) {
                                const t = await e.json();
                                throw new Error(t.error || "Erro ao cadastrar")
                            }
                            ja("✅ Restrição cadastrada com sucesso!", "success"), x(e => ({
                                ...e,
                                restricaoCod: "",
                                restricaoNome: "",
                                restricaoLojaId: "",
                                restricaoTodasLojas: !1,
                                restricaoMotivo: ""
                            }));
                            const t = await fetch(`${API_URL}/disponibilidade/restricoes`),
                                a = await t.json();
                            x(e => ({
                                ...e,
                                restricoesList: a
                            }))
                        } catch (e) {
                            ja(e.message, "error")
                        } else ja('Selecione uma loja ou "Todas as Lojas"', "error");
                        else ja("Preencha o código e o motivo", "error")
                },
                className: "px-6 py-2 bg-red-600 text-white rounded-lg font-semibold hover:bg-red-700"
            }, "🚫 Cadastrar Restrição")), React.createElement("div", {
                className: "bg-white rounded-xl shadow p-4"
            }, React.createElement("h3", {
                className: "font-bold text-gray-800 mb-4"
            }, "📋 Restrições Ativas (", (p.restricoesList || []).length, ")"), p.restricoesLoading ? React.createElement("div", {
                className: "flex items-center justify-center py-8"
            }, React.createElement("div", {
                className: "animate-spin rounded-full h-8 w-8 border-b-2 border-red-600"
            }), React.createElement("span", {
                className: "ml-3 text-gray-600"
            }, "Carregando...")) : 0 === (p.restricoesList || []).length ? React.createElement("div", {
                className: "text-center py-8 text-gray-500"
            }, React.createElement("p", {
                className: "text-4xl mb-2"
            }, "✅"), React.createElement("p", null, "Nenhuma restrição ativa no momento.")) : React.createElement("div", {
                className: "overflow-x-auto"
            }, React.createElement("table", {
                className: "w-full text-xs border-collapse"
            }, React.createElement("thead", null, React.createElement("tr", {
                className: "bg-red-700 text-white"
            }, React.createElement("th", {
                className: "px-2 py-2 text-left"
            }, "COD"), React.createElement("th", {
                className: "px-2 py-2 text-left"
            }, "NOME"), React.createElement("th", {
                className: "px-2 py-2 text-left"
            }, "LOJA"), React.createElement("th", {
                className: "px-2 py-2 text-left"
            }, "MOTIVO"), React.createElement("th", {
                className: "px-2 py-2 text-left"
            }, "CRIADO POR"), React.createElement("th", {
                className: "px-2 py-2 text-left"
            }, "DATA"), React.createElement("th", {
                className: "px-2 py-2 text-center"
            }, "AÇÃO"))), React.createElement("tbody", null, (p.restricoesList || []).map((e, t) => React.createElement("tr", {
                key: e.id,
                className: `border-b ${t%2==0?"bg-white":"bg-red-50"} hover:bg-red-100`
            }, React.createElement("td", {
                className: "px-2 py-2 font-mono font-bold text-red-700"
            }, e.cod_profissional), React.createElement("td", {
                className: "px-2 py-2 font-semibold"
            }, e.nome_profissional || "-"), React.createElement("td", {
                className: "px-2 py-2"
            }, e.todas_lojas ? React.createElement("span", {
                className: "px-2 py-0.5 bg-red-600 text-white rounded text-[10px] font-bold"
            }, "🚫 TODAS") : e.loja_nome ? React.createElement("span", null, e.loja_codigo, " - ", e.loja_nome) : "-"), React.createElement("td", {
                className: "px-2 py-2 max-w-[200px] truncate",
                title: e.motivo
            }, e.motivo), React.createElement("td", {
                className: "px-2 py-2 text-gray-600"
            }, e.criado_por || "-"), React.createElement("td", {
                className: "px-2 py-2 text-gray-600"
            }, new Date(e.created_at).toLocaleDateString("pt-BR")), React.createElement("td", {
                className: "px-2 py-2 text-center"
            }, React.createElement("button", {
                onClick: async () => {
                    if (confirm(`Remover restrição de ${e.cod_profissional} - ${e.nome_profissional||"N/A"}?`)) try {
                        await fetch(`${API_URL}/disponibilidade/restricoes/${e.id}`, {
                            method: "DELETE"
                        }), ja("✅ Restrição removida!", "success");
                        const t = await fetch(`${API_URL}/disponibilidade/restricoes`),
                            a = await t.json();
                        x(e => ({
                            ...e,
                            restricoesList: a
                        }))
                    } catch (e) {
                        ja("Erro ao remover restrição", "error")
                    }
                },
                className: "px-2 py-1 bg-green-600 text-white rounded text-[10px] font-bold hover:bg-green-700"
            }, "✅ Liberar"))))))))), "config" === t && React.createElement("div", {
                className: "space-y-4"
            }, React.createElement("div", {
                className: "bg-white rounded-xl shadow p-4"
            }, React.createElement("h3", {
                className: "font-bold text-gray-800 mb-3"
            }, "🔗 Link Público (Somente Leitura)"), React.createElement("p", {
                className: "text-sm text-gray-600 mb-3"
            }, "Compartilhe este link com gestores para visualizar o panorama em tempo real, sem precisar de login. A página atualiza automaticamente a cada 2 minutos."), React.createElement("div", {
                className: "flex gap-2 flex-wrap"
            }, React.createElement("input", {
                type: "text",
                readOnly: !0,
                value: `${API_URL}/disponibilidade/publico`,
                className: "flex-1 px-3 py-2 bg-gray-100 border rounded-lg text-sm font-mono"
            }), React.createElement("button", {
                onClick: () => {
                    navigator.clipboard.writeText(`${API_URL}/disponibilidade/publico`), ja("✅ Link copiado!", "success")
                },
                className: "px-4 py-2 bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700"
            }, "📋 Copiar Link"), React.createElement("button", {
                onClick: () => window.open(`${API_URL}/disponibilidade/publico`, "_blank"),
                className: "px-4 py-2 bg-green-600 text-white rounded-lg font-semibold hover:bg-green-700"
            }, "🔗 Abrir"))), React.createElement("div", {
                className: "bg-white rounded-xl shadow p-4"
            }, React.createElement("h3", {
                className: "font-bold text-gray-800 mb-3"
            }, "🌍 Regiões"), React.createElement("div", {
                className: "flex gap-2 mb-4"
            }, React.createElement("input", {
                type: "text",
                placeholder: "Nome da região (ex: GOIÂNIA)",
                value: p.novaRegiao || "",
                onChange: e => x({
                    ...p,
                    novaRegiao: e.target.value.toUpperCase()
                }),
                className: "flex-1 px-3 py-2 border rounded-lg",
                onKeyPress: e => "Enter" === e.key && o()
            }), React.createElement("button", {
                onClick: o,
                className: "px-4 py-2 bg-purple-600 text-white rounded-lg font-semibold hover:bg-purple-700"
            }, "+ Adicionar")), React.createElement("div", {
                className: "space-y-2"
            }, (e.regioes || []).map(t => React.createElement("div", {
                key: t.id,
                className: "flex items-center gap-2 p-2 bg-purple-50 rounded-lg"
            }, React.createElement("span", {
                className: "font-semibold text-purple-800 min-w-[150px]"
            }, t.nome), React.createElement("input", {
                type: "text",
                placeholder: "Gestores (ex: LIS / LEO / ERICK)",
                value: t.gestores || "",
                onChange: async a => {
                    const l = a.target.value,
                        r = e.regioes.map(e => e.id === t.id ? {
                            ...e,
                            gestores: l
                        } : e);
                    x(t => ({
                        ...t,
                        dispData: {
                            ...e,
                            regioes: r
                        }
                    })), clearTimeout(window.gestoresDebounce), window.gestoresDebounce = setTimeout(async () => {
                        try {
                            await fetch(`${API_URL}/disponibilidade/regioes/${t.id}`, {
                                method: "PUT",
                                headers: {
                                    "Content-Type": "application/json"
                                },
                                body: JSON.stringify({
                                    gestores: l
                                })
                            })
                        } catch (e) {
                            console.error("Erro ao salvar gestores:", e)
                        }
                    }, 500)
                },
                className: "flex-1 px-2 py-1 border border-purple-200 rounded text-sm"
            }), React.createElement("button", {
                onClick: () => (async (e, t) => {
                    if (window.confirm(`Remover região "${t}" e todas suas lojas?`)) try {
                        await fetch(`${API_URL}/disponibilidade/regioes/${e}`, {
                            method: "DELETE"
                        }), ja(`🗑️ Região "${t}" removida!`, "success"), r()
                    } catch (e) {
                        ja("Erro ao remover região", "error")
                    }
                })(t.id, t.nome),
                className: "text-red-600 hover:text-red-800 font-bold px-2",
                title: "Remover região"
            }, "×"))), 0 === (e.regioes || []).length && React.createElement("p", {
                className: "text-gray-500 text-sm"
            }, "Nenhuma região cadastrada"))), React.createElement("div", {
                className: "bg-white rounded-xl shadow p-4"
            }, React.createElement("h3", {
                className: "font-bold text-gray-800 mb-3"
            }, "🏪 Adicionar Loja"), React.createElement("div", {
                className: "grid grid-cols-1 md:grid-cols-6 gap-3"
            }, React.createElement("select", {
                value: p.novaLojaRegiaoId || "",
                onChange: e => x({
                    ...p,
                    novaLojaRegiaoId: e.target.value
                }),
                className: "px-3 py-2 border rounded-lg"
            }, React.createElement("option", {
                value: ""
            }, "Selecione a Região"), (e.regioes || []).map(e => React.createElement("option", {
                key: e.id,
                value: e.id
            }, e.nome))), React.createElement("input", {
                type: "text",
                placeholder: "Código (ex: 249)",
                value: p.novaCodLoja || "",
                onChange: e => x({
                    ...p,
                    novaCodLoja: e.target.value
                }),
                className: "px-3 py-2 border rounded-lg"
            }), React.createElement("input", {
                type: "text",
                placeholder: "Nome da Loja",
                value: p.novaNomeLoja || "",
                onChange: e => x({
                    ...p,
                    novaNomeLoja: e.target.value.toUpperCase()
                }),
                className: "px-3 py-2 border rounded-lg"
            }), React.createElement("input", {
                type: "number",
                placeholder: "Titulares",
                min: "0",
                value: p.novaQtdTitulares || "",
                onChange: e => x({
                    ...p,
                    novaQtdTitulares: e.target.value
                }),
                className: "px-3 py-2 border rounded-lg",
                title: "Quantidade de linhas titulares"
            }), React.createElement("input", {
                type: "number",
                placeholder: "Excedentes",
                min: "0",
                value: p.novaQtdExcedentes || "",
                onChange: e => x({
                    ...p,
                    novaQtdExcedentes: e.target.value
                }),
                className: "px-3 py-2 border rounded-lg bg-red-50",
                title: "Quantidade de linhas excedentes"
            }), React.createElement("button", {
                onClick: async () => {
                    const e = p.novaCodLoja?.trim(),
                        t = p.novaNomeLoja?.trim(),
                        a = p.novaLojaRegiaoId,
                        l = parseInt(p.novaQtdTitulares) || 0,
                        o = parseInt(p.novaQtdExcedentes) || 0;
                    if (e && t && a)
                        if (0 !== l || 0 !== o) try {
                            if (!(await fetch(`${API_URL}/disponibilidade/lojas`, {
                                    method: "POST",
                                    headers: {
                                        "Content-Type": "application/json"
                                    },
                                    body: JSON.stringify({
                                        regiao_id: a,
                                        codigo: e,
                                        nome: t,
                                        qtd_titulares: l,
                                        qtd_excedentes: o
                                    })
                                })).ok) throw new Error("Erro ao criar loja");
                            x(e => ({
                                ...e,
                                novaCodLoja: "",
                                novaNomeLoja: "",
                                novaQtdTitulares: "",
                                novaQtdExcedentes: "",
                                novaLojaRegiaoId: ""
                            })), ja(`✅ Loja "${t}" adicionada com ${l} titular(es) e ${o} excedente(s)!`, "success"), r()
                        } catch (e) {
                            ja("Erro ao criar loja", "error")
                        } else ja("Adicione pelo menos 1 linha", "error");
                        else ja("Preencha todos os campos", "error")
                },
                className: "px-4 py-2 bg-green-600 text-white rounded-lg font-semibold hover:bg-green-700"
            }, "+ Adicionar Loja")), React.createElement("p", {
                className: "text-xs text-gray-500 mt-2"
            }, "💡 Titulares = linhas principais | Excedentes = linhas extras (aparecem em vermelho claro)")), (e.regioes || []).map(t => {
                const a = (e.lojas || []).filter(e => e.regiao_id === t.id);
                return 0 === a.length ? null : React.createElement("div", {
                    key: t.id,
                    className: "bg-white rounded-xl shadow p-4"
                }, React.createElement("h3", {
                    className: "font-bold text-gray-800 mb-3"
                }, "📍 ", t.nome, " ", t.gestores && React.createElement("span", {
                    className: "font-normal text-gray-500"
                }, "(", t.gestores, ")")), React.createElement("div", {
                    className: "overflow-x-auto"
                }, React.createElement("table", {
                    className: "w-full text-sm"
                }, React.createElement("thead", {
                    className: "bg-gray-100"
                }, React.createElement("tr", null, React.createElement("th", {
                    className: "px-3 py-2 text-left"
                }, "Código"), React.createElement("th", {
                    className: "px-3 py-2 text-left"
                }, "Nome da Loja"), React.createElement("th", {
                    className: "px-3 py-2 text-center"
                }, "Titulares"), React.createElement("th", {
                    className: "px-3 py-2 text-center"
                }, "Excedentes"), React.createElement("th", {
                    className: "px-3 py-2 text-center"
                }, "Total"), React.createElement("th", {
                    className: "px-3 py-2 text-center"
                }, "Ações"))), React.createElement("tbody", null, a.map(t => {
                    const a = (e.linhas || []).filter(e => e.loja_id === t.id),
                        l = a.filter(e => !e.is_excedente).length,
                        o = a.filter(e => e.is_excedente).length,
                        c = p.editandoLoja === t.id;
                    return React.createElement("tr", {
                        key: t.id,
                        className: "border-t"
                    }, React.createElement("td", {
                        className: "px-3 py-2"
                    }, c ? React.createElement("input", {
                        type: "text",
                        value: p.editLojaCodigo || "",
                        onChange: e => x({
                            ...p,
                            editLojaCodigo: e.target.value
                        }),
                        className: "w-20 px-2 py-1 border rounded text-xs"
                    }) : React.createElement("span", {
                        className: "font-mono font-bold"
                    }, t.codigo)), React.createElement("td", {
                        className: "px-3 py-2"
                    }, c ? React.createElement("input", {
                        type: "text",
                        value: p.editLojaNome || "",
                        onChange: e => x({
                            ...p,
                            editLojaNome: e.target.value.toUpperCase()
                        }),
                        className: "w-full px-2 py-1 border rounded text-xs"
                    }) : t.nome), React.createElement("td", {
                        className: "px-3 py-2 text-center"
                    }, React.createElement("span", {
                        className: "px-2 py-0.5 bg-blue-100 text-blue-700 rounded text-xs"
                    }, l)), React.createElement("td", {
                        className: "px-3 py-2 text-center"
                    }, React.createElement("span", {
                        className: "px-2 py-0.5 bg-red-100 text-red-700 rounded text-xs"
                    }, o)), React.createElement("td", {
                        className: "px-3 py-2 text-center font-semibold"
                    }, a.length), React.createElement("td", {
                        className: "px-3 py-2 text-center"
                    }, c ? React.createElement(React.Fragment, null, React.createElement("button", {
                        onClick: async () => {
                            try {
                                await fetch(`${API_URL}/disponibilidade/lojas/${t.id}`, {
                                    method: "PUT",
                                    headers: {
                                        "Content-Type": "application/json"
                                    },
                                    body: JSON.stringify({
                                        codigo: p.editLojaCodigo,
                                        nome: p.editLojaNome
                                    })
                                }), x({
                                    ...p,
                                    editandoLoja: null
                                }), ja("✅ Loja atualizada!", "success"), r()
                            } catch (e) {
                                ja("Erro ao atualizar", "error")
                            }
                        },
                        className: "px-2 py-1 bg-green-100 text-green-700 rounded text-xs mr-1"
                    }, "✓"), React.createElement("button", {
                        onClick: () => x({
                            ...p,
                            editandoLoja: null
                        }),
                        className: "px-2 py-1 bg-gray-100 text-gray-700 rounded text-xs"
                    }, "✕")) : React.createElement(React.Fragment, null, React.createElement("button", {
                        onClick: () => x({
                            ...p,
                            editandoLoja: t.id,
                            editLojaCodigo: t.codigo,
                            editLojaNome: t.nome
                        }),
                        className: "px-2 py-1 bg-yellow-100 text-yellow-700 rounded text-xs mr-1",
                        title: "Editar loja"
                    }, "✏️"), React.createElement("button", {
                        onClick: () => s(t.id, 1, !1),
                        className: "px-2 py-1 bg-blue-100 text-blue-700 rounded text-xs mr-1",
                        title: "Adicionar titular"
                    }, "+T"), React.createElement("button", {
                        onClick: () => s(t.id, 1, !0),
                        className: "px-2 py-1 bg-red-100 text-red-700 rounded text-xs mr-1",
                        title: "Adicionar excedente"
                    }, "+E"), React.createElement("button", {
                        onClick: () => (async (e, t) => {
                            if (window.confirm(`Remover loja "${t}"?`)) try {
                                await fetch(`${API_URL}/disponibilidade/lojas/${e}`, {
                                    method: "DELETE"
                                }), ja("🗑️ Loja removida!", "success"), r()
                            } catch (e) {
                                ja("Erro ao remover loja", "error")
                            }
                        })(t.id, t.nome),
                        className: "px-2 py-1 bg-red-100 text-red-700 rounded text-xs",
                        title: "Remover loja"
                    }, "🗑️"))))
                })))))
            }), (e.linhas || []).length > 0 && React.createElement("div", {
                className: "bg-red-50 border border-red-200 rounded-xl p-4"
            }, React.createElement("div", {
                className: "flex items-center justify-between"
            }, React.createElement("div", null, React.createElement("h4", {
                className: "font-semibold text-red-800"
            }, "🧹 Limpar Todas as Linhas"), React.createElement("p", {
                className: "text-sm text-red-600"
            }, "Reseta todos os entregadores, mantém a estrutura de regiões e lojas.")), React.createElement("button", {
                onClick: async () => {
                    if (window.confirm("Limpar TODAS as linhas? (mantém a estrutura de regiões e lojas)")) try {
                        await fetch(`${API_URL}/disponibilidade/limpar-linhas`, {
                            method: "DELETE"
                        }), ja("✅ Todas as linhas foram resetadas!", "success"), r()
                    } catch (e) {
                        ja("Erro ao limpar linhas", "error")
                    }
                },
                className: "px-4 py-2 bg-red-600 text-white rounded-lg font-semibold hover:bg-red-700"
            }, "Limpar Linhas")))), "principal" === t && React.createElement("div", {
                className: "space-y-4"
            }, React.createElement("div", {
                className: "bg-white rounded-xl shadow p-3"
            }, React.createElement("div", {
                className: "flex justify-between items-center flex-wrap gap-3"
            }, React.createElement("div", {
                className: "flex items-center gap-3"
            }, React.createElement("h2", {
                className: "text-lg font-bold text-gray-800"
            }, "📅 Disponibilidade"), React.createElement("div", {
                className: "flex items-center gap-2 bg-purple-50 px-3 py-1.5 rounded-lg border border-purple-200"
            }, React.createElement("span", {
                className: "text-sm font-semibold text-purple-700"
            }, "Data:"), React.createElement("input", {
                type: "date",
                value: p.dispDataPlanilha || (new Date).toISOString().split("T")[0],
                onChange: e => x({
                    ...p,
                    dispDataPlanilha: e.target.value
                }),
                className: "px-2 py-1 border border-purple-300 rounded text-sm font-semibold text-purple-800 bg-white"
            })), React.createElement("div", {
                className: "flex items-center gap-2 bg-blue-50 px-3 py-1.5 rounded-lg border border-blue-200"
            }, React.createElement("span", {
                className: "text-blue-500"
            }, "🔍"), React.createElement("input", {
                type: "text",
                placeholder: "Buscar código ou nome...",
                value: p.buscaEntregador || "",
                onChange: e => x({
                    ...p,
                    buscaEntregador: e.target.value
                }),
                className: "px-2 py-1 border border-blue-300 rounded text-sm bg-white w-48"
            }), p.buscaEntregador && React.createElement("button", {
                onClick: () => x({
                    ...p,
                    buscaEntregador: ""
                }),
                className: "text-blue-400 hover:text-blue-600"
            }, "×"))), React.createElement("div", {
                className: "flex gap-2"
            }, React.createElement("button", {
                onClick: r,
                className: "px-3 py-1.5 bg-gray-100 text-gray-700 rounded-lg font-semibold hover:bg-gray-200 flex items-center gap-1 text-sm"
            }, "🔄 Atualizar"), React.createElement("button", {
                onClick: async () => {
                    const e = p.dispDataPlanilha || (new Date).toISOString().split("T")[0],
                        t = new Date(e + "T12:00:00").toLocaleDateString("pt-BR");
                    if (window.confirm(`⚠️ ATENÇÃO!\n\n📅 Data da planilha: ${t}\n\nIsso irá:\n• Salvar a planilha atual no Espelho (${t})\n• Registrar motoboys EM LOJA e SEM CONTATO\n• Remover motoboys com 3+ dias SEM CONTATO\n• Resetar todos os status para "A CONFIRMAR"\n• Limpar todas as observações\n• Converter linhas de reposição em excedentes\n\n✅ Os códigos e nomes serão MANTIDOS!\n\nDeseja continuar?`)) try {
                        x(e => ({
                            ...e,
                            dispLoading: !0
                        }));
                        const a = await fetch(`${API_URL}/disponibilidade/resetar`, {
                                method: "POST",
                                headers: {
                                    "Content-Type": "application/json"
                                },
                                body: JSON.stringify({
                                    data_planilha: e
                                })
                            }),
                            l = await a.json();
                        if (l.success) {
                            let e = `✅ Status resetado! Espelho salvo em ${t}`;
                            l.em_loja_registrados > 0 && (e += `\n🏪 ${l.em_loja_registrados} motoboy(s) EM LOJA registrado(s)`), l.sem_contato_registrados > 0 && (e += `\n📵 ${l.sem_contato_registrados} motoboy(s) SEM CONTATO registrado(s)`), l.removidos_por_sem_contato && l.removidos_por_sem_contato.length > 0 && (e += "\n\n🚫 REMOVIDOS POR 3 DIAS SEM CONTATO:", l.removidos_por_sem_contato.forEach(t => {
                                e += `\n• ${t.cod} - ${t.nome}`
                            })), ja(e, "success"), l.removidos_por_sem_contato && l.removidos_por_sem_contato.length > 0 && setTimeout(() => {
                                alert(`🚫 MOTOBOYS REMOVIDOS POR 3 DIAS SEM CONTATO:\n\n${l.removidos_por_sem_contato.map(e=>`${e.cod} - ${e.nome}`).join("\n")}`)
                            }, 500)
                        } else ja("Erro ao resetar", "error");
                        r()
                    } catch (e) {
                        console.error("Erro ao resetar:", e), ja("Erro ao resetar", "error"), x(e => ({
                            ...e,
                            dispLoading: !1
                        }))
                    }
                },
                className: "px-3 py-1.5 bg-orange-100 text-orange-700 rounded-lg font-semibold hover:bg-orange-200 flex items-center gap-1 text-sm"
            }, "🔄 Resetar Status"))), p.buscaEntregador && p.buscaEntregador.length >= 2 && React.createElement("div", {
                className: "mt-3 p-3 bg-blue-50 rounded-lg"
            }, React.createElement("p", {
                className: "text-xs font-semibold text-blue-700 mb-2"
            }, 'Resultados para "', p.buscaEntregador, '":'), React.createElement("div", {
                className: "space-y-1 max-h-40 overflow-y-auto"
            }, (() => {
                const t = p.buscaEntregador.toLowerCase(),
                    a = (e.linhas || []).filter(e => e.cod_profissional && e.cod_profissional.toLowerCase().includes(t) || e.nome_profissional && e.nome_profissional.toLowerCase().includes(t));
                return 0 === a.length ? React.createElement("p", {
                    className: "text-gray-500 text-sm"
                }, "Nenhum resultado encontrado") : a.slice(0, 10).map(t => {
                    const a = (e.lojas || []).find(e => e.id === t.loja_id);
                    return React.createElement("div", {
                        key: t.id,
                        className: "flex items-center justify-between p-2 bg-white rounded text-xs"
                    }, React.createElement("div", {
                        className: "flex items-center gap-2"
                    }, React.createElement("span", {
                        className: "font-mono font-bold"
                    }, t.cod_profissional || "-"), React.createElement("span", null, t.nome_profissional || "Sem nome")), React.createElement("div", {
                        className: "flex items-center gap-2"
                    }, React.createElement("span", {
                        className: "text-gray-500"
                    }, a?.nome || ""), React.createElement("span", {
                        className: "px-2 py-0.5 rounded text-[10px] font-bold " + ("EM LOJA" === t.status ? "bg-blue-100 text-blue-700" : "CONFIRMADO" === t.status ? "bg-green-100 text-green-700" : "A CAMINHO" === t.status ? "bg-orange-100 text-orange-700" : "FALTANDO" === t.status ? "bg-red-100 text-red-700" : "bg-gray-100 text-gray-700")
                    }, t.status)))
                })
            })()))), p.modalFaltando && React.createElement("div", {
                className: "fixed inset-0 bg-black/50 flex items-center justify-center z-50"
            }, React.createElement("div", {
                className: "bg-white rounded-xl shadow-xl p-6 w-full max-w-md mx-4"
            }, React.createElement("h3", {
                className: "text-lg font-bold text-red-600 mb-4"
            }, "⚠️ Registrar Falta"), React.createElement("div", {
                className: "mb-4"
            }, React.createElement("p", {
                className: "text-sm text-gray-600 mb-2"
            }, React.createElement("strong", null, "Profissional:"), " ", p.faltandoLinha?.nome_profissional || p.faltandoLinha?.cod_profissional || "Não identificado"), React.createElement("label", {
                className: "text-sm font-semibold text-gray-700"
            }, "Motivo da falta *"), React.createElement("textarea", {
                value: p.faltandoMotivo || "",
                onChange: e => x({
                    ...p,
                    faltandoMotivo: e.target.value
                }),
                placeholder: "Digite o motivo da falta...",
                className: "w-full px-3 py-2 border rounded-lg mt-1 text-sm",
                rows: 3,
                autoFocus: !0
            })), React.createElement("div", {
                className: "flex gap-2"
            }, React.createElement("button", {
                onClick: () => x({
                    ...p,
                    modalFaltando: !1,
                    faltandoLinha: null,
                    faltandoMotivo: ""
                }),
                className: "flex-1 px-4 py-2 bg-gray-100 text-gray-700 rounded-lg font-semibold hover:bg-gray-200"
            }, "Cancelar"), React.createElement("button", {
                onClick: async () => {
                    const t = p.faltandoLinha,
                        a = p.faltandoMotivo?.trim();
                    if (!a) return void ja("Digite o motivo da falta", "error");
                    const l = p.dispDataPlanilha || (new Date).toISOString().split("T")[0];
                    try {
                        await fetch(`${API_URL}/disponibilidade/linhas/${t.id}`, {
                            method: "PUT",
                            headers: {
                                "Content-Type": "application/json"
                            },
                            body: JSON.stringify({
                                cod_profissional: t.cod_profissional,
                                nome_profissional: t.nome_profissional,
                                status: "FALTANDO",
                                observacao: a
                            })
                        }), await fetch(`${API_URL}/disponibilidade/faltosos`, {
                            method: "POST",
                            headers: {
                                "Content-Type": "application/json"
                            },
                            body: JSON.stringify({
                                loja_id: t.loja_id,
                                cod_profissional: t.cod_profissional,
                                nome_profissional: t.nome_profissional,
                                motivo: a,
                                data_falta: l
                            })
                        });
                        const r = await fetch(`${API_URL}/disponibilidade/linha-reposicao`, {
                                method: "POST",
                                headers: {
                                    "Content-Type": "application/json"
                                },
                                body: JSON.stringify({
                                    loja_id: t.loja_id,
                                    after_linha_id: t.id
                                })
                            }),
                            o = await r.json(),
                            c = [...e.linhas || []],
                            s = c.findIndex(e => e.id === t.id); - 1 !== s && (c[s] = {
                            ...c[s],
                            status: "FALTANDO",
                            observacao: a
                        }), c.push(o), x(t => ({
                            ...t,
                            modalFaltando: !1,
                            faltandoLinha: null,
                            faltandoMotivo: "",
                            dispData: {
                                ...e,
                                linhas: c
                            }
                        })), ja("⚠️ Falta registrada e linha de reposição criada!", "success")
                    } catch (e) {
                        console.error("Erro ao registrar falta:", e), ja("Erro ao registrar falta", "error")
                    }
                },
                className: "flex-1 px-4 py-2 bg-red-600 text-white rounded-lg font-semibold hover:bg-red-700"
            }, "✓ Confirmar Falta")))), 0 === (e.regioes || []).length ? React.createElement("div", {
                className: "bg-white rounded-xl shadow p-8 text-center"
            }, React.createElement("p", {
                className: "text-gray-500 text-lg"
            }, "Nenhuma estrutura configurada."), React.createElement("button", {
                onClick: () => x({
                    ...p,
                    dispSubTab: "config"
                }),
                className: "mt-4 px-6 py-2 bg-purple-600 text-white rounded-lg font-semibold"
            }, "⚙️ Configurar Estrutura")) : React.createElement(React.Fragment, null, React.createElement("div", {
                className: "flex flex-wrap gap-2"
            }, (e.regioes || []).map(t => {
                const a = (e.lojas || []).filter(e => e.regiao_id === t.id),
                    l = (e.linhas || []).filter(e => a.some(t => t.id === e.loja_id)),
                    r = l.filter(e => "EM LOJA" === e.status).length,
                    o = l.filter(e => !e.is_excedente && !e.is_reposicao).length;
                return React.createElement("button", {
                    key: t.id,
                    onClick: () => x({
                        ...p,
                        dispRegiaoAtiva: p.dispRegiaoAtiva === t.id ? null : t.id
                    }),
                    className: "px-3 py-1.5 rounded-lg font-semibold transition-all flex items-center gap-2 text-sm " + (p.dispRegiaoAtiva === t.id ? "bg-purple-600 text-white shadow-lg" : "bg-white text-gray-700 border hover:bg-purple-50 hover:border-purple-300")
                }, "📍 ", t.nome, React.createElement("span", {
                    className: "text-xs px-2 py-0.5 rounded-full font-bold " + (p.dispRegiaoAtiva === t.id ? "bg-white/20 text-white" : r >= o && o > 0 ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-600")
                }, r, "/", o))
            })), p.dispRegiaoAtiva && (() => {
                const t = (e.regioes || []).find(e => e.id === p.dispRegiaoAtiva);
                if (!t) return null;
                const a = (e.lojas || []).filter(e => e.regiao_id === t.id);
                return React.createElement("div", {
                    className: "space-y-2"
                }, a.map(t => {
                    const a = (e.linhas || []).filter(e => e.loja_id === t.id),
                        l = (p.dispLojasAbertas || []).includes(t.id),
                        o = a.filter(e => "EM LOJA" === e.status).length,
                        s = a.filter(e => !e.is_excedente && !e.is_reposicao).length,
                        i = a.filter(e => "FALTANDO" === e.status).length;
                    a.filter(e => e.is_reposicao).length;
                    let d = "bg-gray-100 hover:bg-gray-200";
                    return i > 0 ? d = "bg-red-100 hover:bg-red-200" : o >= s && s > 0 ? d = "bg-green-100 hover:bg-green-200" : o > 0 && (d = "bg-yellow-100 hover:bg-yellow-200"), React.createElement("div", {
                        key: t.id,
                        className: "bg-white rounded-lg shadow overflow-hidden"
                    }, React.createElement("button", {
                        onClick: () => {
                            const e = p.dispLojasAbertas || [];
                            x(l ? {
                                ...p,
                                dispLojasAbertas: e.filter(e => e !== t.id)
                            } : {
                                ...p,
                                dispLojasAbertas: [...e, t.id]
                            })
                        },
                        className: `w-full px-3 py-2 flex items-center justify-between ${d} transition-colors`
                    }, React.createElement("div", {
                        className: "flex items-center gap-2"
                    }, React.createElement("span", {
                        className: "transform transition-transform text-xs " + (l ? "rotate-90" : "")
                    }, "▶"), React.createElement("span", {
                        className: "font-mono font-bold text-purple-700 text-sm"
                    }, t.codigo), React.createElement("span", {
                        className: "font-semibold text-gray-800 text-sm"
                    }, t.nome)), React.createElement("div", {
                        className: "flex items-center gap-2"
                    }, i > 0 && React.createElement("span", {
                        className: "px-2 py-0.5 bg-red-500 text-white text-xs rounded-full font-semibold"
                    }, i, " faltando"), React.createElement("span", {
                        className: "text-xs font-semibold px-2 py-0.5 rounded " + (o >= s ? "bg-green-200 text-green-800" : "bg-gray-200 text-gray-700")
                    }, o, "/", s, " em loja"))), l && React.createElement("div", {
                        className: "border-t",
                        "data-loja-id": t.id
                    }, React.createElement("table", {
                        className: "w-full text-xs"
                    }, React.createElement("thead", {
                        className: "bg-gray-50"
                    }, React.createElement("tr", null, React.createElement("th", {
                        className: "w-1"
                    }), React.createElement("th", {
                        className: "px-2 py-1 text-center w-20"
                    }, "COD"), React.createElement("th", {
                        className: "px-2 py-1 text-left"
                    }, "ENTREGADOR"), React.createElement("th", {
                        className: "px-2 py-1 text-center w-36"
                    }, "STATUS"), React.createElement("th", {
                        className: "px-2 py-1 text-left"
                    }, "OBS"), React.createElement("th", {
                        className: "px-1 py-1 text-center w-6"
                    }))), React.createElement("tbody", null, [...a].sort((e, t) => e.is_reposicao && !t.is_reposicao ? -1 : !e.is_reposicao && t.is_reposicao || e.is_excedente && !t.is_excedente ? 1 : !e.is_excedente && t.is_excedente ? -1 : 0).map((e, a) => React.createElement("tr", {
                        key: e.id,
                        className: `border-t ${e.is_reposicao?"bg-blue-50/50":e.is_excedente?"bg-red-50/50":""} ${e.is_excedente||e.is_reposicao||!m[e.status]?"":m[e.status]} hover:bg-gray-50`
                    }, React.createElement("td", {
                        className: "w-1 " + (e.is_reposicao ? "bg-blue-400" : e.is_excedente ? "bg-red-400" : "")
                    }), React.createElement("td", {
                        className: "px-1 py-0.5"
                    }, React.createElement("input", {
                        type: "text",
                        value: e.cod_profissional || "",
                        onChange: t => c(e.id, "cod_profissional", t.target.value),
                        onKeyDown: e => {
                            if ("ArrowDown" === e.key || "ArrowUp" === e.key) {
                                e.preventDefault();
                                const a = document.querySelectorAll(`[data-loja-id="${t.id}"] input[data-cod-input]`),
                                    l = Array.from(a).findIndex(t => t === e.target);
                                let r = "ArrowDown" === e.key ? l + 1 : l - 1;
                                r >= 0 && r < a.length && (a[r].focus(), a[r].select())
                            }
                            if ("Enter" === e.key) {
                                e.preventDefault();
                                const a = document.querySelectorAll(`[data-loja-id="${t.id}"] input[data-cod-input]`),
                                    l = Array.from(a).findIndex(t => t === e.target);
                                l + 1 < a.length && (a[l + 1].focus(), a[l + 1].select())
                            }
                        },
                        "data-cod-input": e.id,
                        placeholder: "...",
                        className: "w-full px-1 py-0.5 border border-gray-200 rounded text-center font-mono text-xs " + (e.is_reposicao ? "bg-blue-50/50" : e.is_excedente ? "bg-red-50/50" : "bg-white")
                    })), React.createElement("td", {
                        className: "px-1 py-0.5"
                    }, React.createElement("div", {
                        className: "flex items-center gap-1"
                    }, e.is_reposicao && React.createElement("span", {
                        className: "text-[9px] text-blue-400 italic"
                    }, "reposição"), e.is_excedente && React.createElement("span", {
                        className: "text-[9px] text-red-400 italic"
                    }, "excedente"), React.createElement("span", {
                        className: "text-xs " + (e.nome_profissional ? "text-gray-800" : "text-gray-400 italic")
                    }, e.nome_profissional || (e.is_reposicao || e.is_excedente ? "" : "-")))), React.createElement("td", {
                        className: "px-1 py-0.5"
                    }, React.createElement("select", {
                        value: e.status || "A CONFIRMAR",
                        onChange: t => {
                            "FALTANDO" === t.target.value ? (e => {
                                x(t => ({
                                    ...t,
                                    modalFaltando: !0,
                                    faltandoLinha: e,
                                    faltandoMotivo: ""
                                }))
                            })(e) : c(e.id, "status", t.target.value)
                        },
                        className: `w-full px-1 py-0.5 border border-gray-200 rounded text-xs font-semibold ${n[e.status]||""}`
                    }, React.createElement("option", {
                        value: "A CONFIRMAR"
                    }, "A CONFIRMAR"), React.createElement("option", {
                        value: "CONFIRMADO"
                    }, "CONFIRMADO"), React.createElement("option", {
                        value: "A CAMINHO"
                    }, "A CAMINHO"), React.createElement("option", {
                        value: "EM LOJA"
                    }, "EM LOJA"), React.createElement("option", {
                        value: "FALTANDO"
                    }, "FALTANDO"), React.createElement("option", {
                        value: "SEM CONTATO"
                    }, "SEM CONTATO"))), React.createElement("td", {
                        className: "px-1 py-0.5"
                    }, React.createElement("input", {
                        type: "text",
                        value: e.observacao || "",
                        onChange: t => c(e.id, "observacao", t.target.value),
                        placeholder: "...",
                        className: "w-full px-1 py-0.5 border border-gray-200 rounded text-xs " + (e.is_excedente ? "bg-red-50/50" : e.is_reposicao ? "bg-blue-50/50" : "bg-white")
                    })), React.createElement("td", {
                        className: "px-1 py-0.5 text-center"
                    }, React.createElement("button", {
                        onClick: () => (async e => {
                            try {
                                await fetch(`${API_URL}/disponibilidade/linhas/${e}`, {
                                    method: "DELETE"
                                }), r()
                            } catch (e) {
                                ja("Erro ao remover linha", "error")
                            }
                        })(e.id),
                        className: "text-red-400 hover:text-red-600 text-xs",
                        title: "Remover"
                    }, "×"))))))))
                }), React.createElement("div", {
                    className: "flex gap-2 pt-2"
                }, React.createElement("button", {
                    onClick: () => x({
                        ...p,
                        dispLojasAbertas: a.map(e => e.id)
                    }),
                    className: "px-3 py-1 text-xs bg-gray-100 text-gray-600 rounded hover:bg-gray-200"
                }, "📂 Expandir Todas"), React.createElement("button", {
                    onClick: () => x({
                        ...p,
                        dispLojasAbertas: []
                    }),
                    className: "px-3 py-1 text-xs bg-gray-100 text-gray-600 rounded hover:bg-gray-200"
                }, "📁 Recolher Todas")))
            })(), !p.dispRegiaoAtiva && React.createElement("div", {
                className: "bg-white rounded-xl shadow p-8 text-center"
            }, React.createElement("p", {
                className: "text-gray-500"
            }, "👆 Selecione uma região acima para ver as lojas"))), (e.regioes || []).length > 0 && React.createElement("div", {
                className: "bg-white rounded-xl shadow p-3"
            }, React.createElement("h4", {
                className: "font-semibold text-gray-700 mb-2 text-sm"
            }, "📊 Legenda"), React.createElement("div", {
                className: "flex flex-wrap gap-2 text-xs"
            }, React.createElement("span", {
                className: "px-2 py-1 bg-yellow-100 text-yellow-800 rounded font-semibold"
            }, "A CONFIRMAR"), React.createElement("span", {
                className: "px-2 py-1 bg-green-100 text-green-800 rounded font-semibold"
            }, "CONFIRMADO"), React.createElement("span", {
                className: "px-2 py-1 bg-blue-100 text-blue-800 rounded font-semibold"
            }, "EM LOJA"), React.createElement("span", {
                className: "px-2 py-1 bg-red-100 text-red-800 rounded font-semibold"
            }, "FALTANDO"), React.createElement("span", {
                className: "px-2 py-1 bg-red-50 text-red-700 rounded font-semibold border-l-4 border-red-400"
            }, "EXCEDENTE"), React.createElement("span", {
                className: "px-2 py-1 bg-blue-50 text-blue-700 rounded font-semibold border-l-4 border-blue-400"
            }, "REPOSIÇÃO")))), "faltosos" === t && React.createElement("div", {
                className: "space-y-4"
            }, React.createElement("div", {
                className: "bg-white rounded-xl shadow p-4"
            }, React.createElement("h3", {
                className: "font-bold text-gray-800 mb-3"
            }, "🔍 Filtros"), React.createElement("div", {
                className: "grid grid-cols-1 md:grid-cols-4 gap-3"
            }, React.createElement("div", null, React.createElement("label", {
                className: "text-xs text-gray-600"
            }, "Data Início"), React.createElement("input", {
                type: "date",
                value: p.faltososDataInicio || "",
                onChange: e => x({
                    ...p,
                    faltososDataInicio: e.target.value
                }),
                className: "w-full px-3 py-2 border rounded-lg text-sm"
            })), React.createElement("div", null, React.createElement("label", {
                className: "text-xs text-gray-600"
            }, "Data Fim"), React.createElement("input", {
                type: "date",
                value: p.faltososDataFim || "",
                onChange: e => x({
                    ...p,
                    faltososDataFim: e.target.value
                }),
                className: "w-full px-3 py-2 border rounded-lg text-sm"
            })), React.createElement("div", null, React.createElement("label", {
                className: "text-xs text-gray-600"
            }, "Loja"), React.createElement("select", {
                value: p.faltososLojaId || "",
                onChange: e => x({
                    ...p,
                    faltososLojaId: e.target.value
                }),
                className: "w-full px-3 py-2 border rounded-lg text-sm"
            }, React.createElement("option", {
                value: ""
            }, "Todas as lojas"), (e.lojas || []).map(e => React.createElement("option", {
                key: e.id,
                value: e.id
            }, e.codigo, " - ", e.nome)))), React.createElement("div", {
                className: "flex items-end gap-2"
            }, React.createElement("button", {
                onClick: async () => {
                    try {
                        let e = `${API_URL}/disponibilidade/faltosos?`;
                        p.faltososDataInicio && (e += `data_inicio=${p.faltososDataInicio}&`), p.faltososDataFim && (e += `data_fim=${p.faltososDataFim}&`), p.faltososLojaId && (e += `loja_id=${p.faltososLojaId}`);
                        const t = await fetch(e),
                            a = await t.json();
                        x(e => ({
                            ...e,
                            faltososLista: a
                        }))
                    } catch (e) {
                        ja("Erro ao buscar faltosos", "error")
                    }
                },
                className: "flex-1 px-4 py-2 bg-purple-600 text-white rounded-lg font-semibold hover:bg-purple-700"
            }, "🔍 Buscar"), React.createElement("button", {
                onClick: async () => {
                    x(e => ({
                        ...e,
                        faltososDataInicio: "",
                        faltososDataFim: "",
                        faltososLojaId: ""
                    }));
                    try {
                        const e = await fetch(`${API_URL}/disponibilidade/faltosos`),
                            t = await e.json();
                        x(e => ({
                            ...e,
                            faltososLista: t
                        }))
                    } catch (e) {
                        ja("Erro ao buscar faltosos", "error")
                    }
                },
                className: "px-4 py-2 bg-gray-200 text-gray-700 rounded-lg font-semibold hover:bg-gray-300"
            }, "🔄 Limpar")))), React.createElement("div", {
                className: "bg-white rounded-xl shadow overflow-hidden"
            }, React.createElement("div", {
                className: "px-4 py-3 bg-gray-50 border-b flex justify-between items-center"
            }, React.createElement("h3", {
                className: "font-bold text-gray-800"
            }, "📋 Registro de Faltas (", (p.faltososLista || []).length, ")")), React.createElement("div", {
                className: "overflow-x-auto"
            }, React.createElement("table", {
                className: "w-full text-xs"
            }, React.createElement("thead", {
                className: "bg-gray-100"
            }, React.createElement("tr", null, React.createElement("th", {
                className: "px-3 py-2 text-left"
            }, "DATA"), React.createElement("th", {
                className: "px-3 py-2 text-left"
            }, "REGIÃO"), React.createElement("th", {
                className: "px-3 py-2 text-left"
            }, "LOJA"), React.createElement("th", {
                className: "px-3 py-2 text-left"
            }, "COD"), React.createElement("th", {
                className: "px-3 py-2 text-left"
            }, "PROFISSIONAL"), React.createElement("th", {
                className: "px-3 py-2 text-left"
            }, "MOTIVO"), React.createElement("th", {
                className: "px-3 py-2 text-center w-16"
            }, "AÇÃO"))), React.createElement("tbody", null, 0 === (p.faltososLista || []).length ? React.createElement("tr", null, React.createElement("td", {
                colSpan: "7",
                className: "px-3 py-8 text-center text-gray-500"
            }, "Nenhum registro de falta encontrado.")) : (p.faltososLista || []).map(e => React.createElement("tr", {
                key: e.id,
                className: "border-t hover:bg-gray-50"
            }, React.createElement("td", {
                className: "px-3 py-2"
            }, new Date(e.data_falta).toLocaleDateString("pt-BR")), React.createElement("td", {
                className: "px-3 py-2"
            }, e.regiao_nome), React.createElement("td", {
                className: "px-3 py-2 font-mono"
            }, e.loja_codigo, " - ", e.loja_nome), React.createElement("td", {
                className: "px-3 py-2 font-mono"
            }, e.cod_profissional || "-"), React.createElement("td", {
                className: "px-3 py-2"
            }, e.nome_profissional || "-"), React.createElement("td", {
                className: "px-3 py-2 text-red-600"
            }, e.motivo), React.createElement("td", {
                className: "px-3 py-2 text-center"
            }, React.createElement("button", {
                onClick: async () => {
                    if (window.confirm(`Excluir registro de falta de ${e.nome_profissional||e.cod_profissional}?`)) try {
                        await fetch(`${API_URL}/disponibilidade/faltosos/${e.id}`, {
                            method: "DELETE"
                        }), x(t => ({
                            ...t,
                            faltososLista: t.faltososLista.filter(t => t.id !== e.id)
                        })), ja("✅ Falta excluída", "success")
                    } catch (e) {
                        ja("Erro ao excluir", "error")
                    }
                },
                className: "text-red-500 hover:text-red-700 hover:bg-red-50 px-2 py-1 rounded",
                title: "Excluir falta"
            }, "🗑️"))))))))), "espelho" === t && React.createElement("div", {
                className: "space-y-4"
            }, React.createElement("div", {
                className: "bg-white rounded-xl shadow p-4"
            }, React.createElement("h3", {
                className: "font-bold text-gray-800 mb-3"
            }, "🪞 Histórico de Planilhas"), React.createElement("div", {
                className: "flex gap-3 items-end"
            }, React.createElement("div", {
                className: "flex-1"
            }, React.createElement("label", {
                className: "text-xs text-gray-600"
            }, "Selecione a data"), React.createElement("select", {
                value: p.espelhoDataSelecionada || "",
                onChange: async e => {
                    const t = e.target.value;
                    if (x(e => ({
                            ...e,
                            espelhoDataSelecionada: t,
                            espelhoCarregando: !0
                        })), t) try {
                        const e = await fetch(`${API_URL}/disponibilidade/espelho/${t}`),
                            a = await e.json();
                        console.log("Espelho carregado:", a), x(e => ({
                            ...e,
                            espelhoDados: a.dados,
                            espelhoCarregando: !1
                        }))
                    } catch (e) {
                        console.error("Erro ao carregar espelho:", e), ja("Erro ao carregar espelho", "error"), x(e => ({
                            ...e,
                            espelhoCarregando: !1
                        }))
                    } else x(e => ({
                        ...e,
                        espelhoDados: null,
                        espelhoCarregando: !1
                    }))
                },
                className: "w-full px-3 py-2 border rounded-lg text-sm"
            }, React.createElement("option", {
                value: ""
            }, "Selecione uma data..."), (p.espelhoDatas || []).map(e => {
                const t = e.data_registro?.split("T")[0] || e.data_registro,
                    [a, l, r] = (t || "").split("-"),
                    o = a && l && r ? `${r}/${l}/${a}` : t;
                return React.createElement("option", {
                    key: e.id,
                    value: t
                }, o)
            }))), React.createElement("button", {
                onClick: async () => {
                    try {
                        const e = await fetch(`${API_URL}/disponibilidade/espelho`),
                            t = await e.json();
                        console.log("Datas espelho:", t), x(e => ({
                            ...e,
                            espelhoDatas: t
                        })), ja(`${t.length} data(s) encontrada(s)!`, "success")
                    } catch (e) {
                        ja("Erro ao carregar datas", "error")
                    }
                },
                className: "px-4 py-2 bg-gray-100 text-gray-700 rounded-lg font-semibold hover:bg-gray-200"
            }, "🔄 Atualizar"), p.espelhoDataSelecionada && React.createElement("button", {
                onClick: async () => {
                    const e = (p.espelhoDatas || []).find(e => (e.data_registro?.split("T")[0] || e.data_registro) === p.espelhoDataSelecionada);
                    if (!e) return;
                    const t = p.espelhoDataSelecionada.split("-").reverse().join("/");
                    if (window.confirm(`⚠️ Excluir espelho de ${t}?\n\nEssa ação não pode ser desfeita.`)) try {
                        await fetch(`${API_URL}/disponibilidade/espelho/${e.id}`, {
                            method: "DELETE"
                        });
                        const a = await fetch(`${API_URL}/disponibilidade/espelho`),
                            l = await a.json();
                        x(e => ({
                            ...e,
                            espelhoDatas: l,
                            espelhoDataSelecionada: "",
                            espelhoDados: null
                        })), ja(`✅ Espelho de ${t} excluído`, "success")
                    } catch (e) {
                        ja("Erro ao excluir espelho", "error")
                    }
                },
                className: "px-4 py-2 bg-red-100 text-red-700 rounded-lg font-semibold hover:bg-red-200"
            }, "🗑️ Excluir")), React.createElement("p", {
                className: "text-xs text-gray-500 mt-2"
            }, 0 === (p.espelhoDatas || []).length ? 'Nenhum espelho salvo ainda. Use "Resetar Status" para criar o primeiro.' : `${(p.espelhoDatas||[]).length} espelho(s) disponível(is)`)), p.espelhoCarregando ? React.createElement("div", {
                className: "bg-white rounded-xl shadow p-8 text-center"
            }, React.createElement("div", {
                className: "animate-spin rounded-full h-8 w-8 border-b-2 border-purple-600 mx-auto"
            }), React.createElement("p", {
                className: "mt-2 text-gray-500"
            }, "Carregando...")) : p.espelhoDados ? React.createElement("div", {
                className: "space-y-4"
            }, (() => {
                const e = "string" == typeof p.espelhoDados ? JSON.parse(p.espelhoDados) : p.espelhoDados;
                return console.log("Dados do espelho:", e), e && e.regioes && 0 !== e.regioes.length ? (e.regioes || []).map(t => {
                    const a = (e.lojas || []).filter(e => e.regiao_id === t.id);
                    return 0 === a.length ? null : React.createElement("div", {
                        key: t.id,
                        className: "bg-white rounded-xl shadow overflow-hidden"
                    }, React.createElement("div", {
                        className: "bg-gradient-to-r from-purple-600 to-indigo-600 px-4 py-2"
                    }, React.createElement("h3", {
                        className: "font-bold text-white text-sm"
                    }, "📍 ", t.nome)), a.map(t => {
                        const a = (e.linhas || []).filter(e => e.loja_id === t.id);
                        return React.createElement("div", {
                            key: t.id,
                            className: "border-t"
                        }, React.createElement("div", {
                            className: "px-3 py-2 bg-gray-50 font-semibold text-sm"
                        }, t.codigo, " - ", t.nome), React.createElement("table", {
                            className: "w-full text-xs"
                        }, React.createElement("tbody", null, [...a].sort((e, t) => e.is_reposicao && !t.is_reposicao ? -1 : !e.is_reposicao && t.is_reposicao || e.is_excedente && !t.is_excedente ? 1 : !e.is_excedente && t.is_excedente ? -1 : 0).map(e => React.createElement("tr", {
                            key: e.id,
                            className: `border-t ${e.is_excedente?"bg-red-50":""} ${e.is_reposicao?"bg-blue-50":""}`
                        }, React.createElement("td", {
                            className: `w-1 ${e.is_excedente?"bg-red-400":""} ${e.is_reposicao?"bg-blue-400":""}`
                        }), React.createElement("td", {
                            className: "px-2 py-1 font-mono w-20"
                        }, e.cod_profissional || "-"), React.createElement("td", {
                            className: "px-2 py-1"
                        }, React.createElement("div", {
                            className: "flex items-center gap-1"
                        }, e.is_reposicao && React.createElement("span", {
                            className: "text-[9px] text-blue-400 italic"
                        }, "reposição"), e.is_excedente && React.createElement("span", {
                            className: "text-[9px] text-red-400 italic"
                        }, "excedente"), React.createElement("span", null, e.nome_profissional || (e.is_reposicao || e.is_excedente ? "" : "-")))), React.createElement("td", {
                            className: "px-2 py-1 w-28"
                        }, React.createElement("span", {
                            className: "px-1 py-0.5 rounded text-xs " + ("EM LOJA" === e.status ? "bg-blue-100 text-blue-800" : "CONFIRMADO" === e.status ? "bg-green-100 text-green-800" : "FALTANDO" === e.status ? "bg-red-100 text-red-800" : "bg-yellow-100 text-yellow-800")
                        }, e.status)), React.createElement("td", {
                            className: "px-2 py-1 text-gray-500"
                        }, e.observacao || ""))))))
                    }))
                }) : React.createElement("div", {
                    className: "bg-white rounded-xl shadow p-8 text-center"
                }, React.createElement("p", {
                    className: "text-gray-500"
                }, "Espelho vazio ou sem dados"))
            })()) : React.createElement("div", {
                className: "bg-white rounded-xl shadow p-8 text-center"
            }, React.createElement("p", {
                className: "text-gray-500"
            }, "Selecione uma data para visualizar o histórico"))))
        })()), "relatorios" === p.adminTab && (() => {
            const e = void 0 !== p.relMes ? parseInt(p.relMes) : (new Date).getMonth(),
                t = void 0 !== p.relAno ? parseInt(p.relAno) : (new Date).getFullYear(),
                a = j.filter(a => {
                    const l = new Date(a.created_at);
                    return l.getMonth() === e && l.getFullYear() === t
                }),
                l = a.filter(e => "aprovada" === e.status),
                r = a.filter(e => "rejeitada" === e.status),
                o = a.filter(e => "pendente" === e.status),
                c = a.length > 0 ? (l.length / a.length * 100).toFixed(1) : 0,
                s = a.length > 0 ? (r.length / a.length * 100).toFixed(1) : 0,
                n = {};
            a.forEach(e => {
                const t = e.motivo || "Outros";
                n[t] || (n[t] = {
                    total: 0,
                    aprovadas: 0,
                    rejeitadas: 0,
                    pendentes: 0
                }), n[t].total++, "aprovada" === e.status && n[t].aprovadas++, "rejeitada" === e.status && n[t].rejeitadas++, "pendente" === e.status && n[t].pendentes++
            });
            const m = {};
            a.forEach(e => {
                const t = e.user_name || e.cod_profissional || "Desconhecido";
                m[t] || (m[t] = {
                    total: 0,
                    aprovadas: 0,
                    rejeitadas: 0,
                    cod: e.cod_profissional
                }), m[t].total++, "aprovada" === e.status && m[t].aprovadas++, "rejeitada" === e.status && m[t].rejeitadas++
            });
            const i = Object.entries(m).map(([e, t]) => ({
                    nome: e,
                    ...t,
                    taxa: t.total > 0 ? (t.aprovadas / t.total * 100).toFixed(0) : 0
                })).sort((e, t) => t.total - e.total).slice(0, 10),
                d = [{
                    label: "Semana 1",
                    dias: [1, 7],
                    total: 0,
                    aprovadas: 0
                }, {
                    label: "Semana 2",
                    dias: [8, 14],
                    total: 0,
                    aprovadas: 0
                }, {
                    label: "Semana 3",
                    dias: [15, 21],
                    total: 0,
                    aprovadas: 0
                }, {
                    label: "Semana 4",
                    dias: [22, 31],
                    total: 0,
                    aprovadas: 0
                }];
            a.forEach(e => {
                const t = new Date(e.created_at).getDate(),
                    a = d.find(e => t >= e.dias[0] && t <= e.dias[1]);
                a && (a.total++, "aprovada" === e.status && a.aprovadas++)
            });
            const u = Math.max(...d.map(e => e.total), 1),
                g = [];
            for (let a = 5; a >= 0; a--) {
                const l = new Date(t, e - a, 1),
                    r = l.getMonth(),
                    o = l.getFullYear(),
                    c = j.filter(e => {
                        const t = new Date(e.created_at);
                        return t.getMonth() === r && t.getFullYear() === o
                    });
                g.push({
                    label: l.toLocaleDateString("pt-BR", {
                        month: "short"
                    }),
                    total: c.length,
                    aprovadas: c.filter(e => "aprovada" === e.status).length
                })
            }
            const b = Math.max(...g.map(e => e.total), 1),
                R = new Date(t, e - 1, 1),
                E = j.filter(e => {
                    const t = new Date(e.created_at);
                    return t.getMonth() === R.getMonth() && t.getFullYear() === R.getFullYear()
                }),
                h = E.length > 0 ? ((a.length - E.length) / E.length * 100).toFixed(1) : 0,
                f = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];
            return React.createElement(React.Fragment, null, React.createElement("div", {
                className: "bg-white rounded-xl shadow p-4 mb-6 flex flex-wrap items-center gap-4"
            }, React.createElement("div", {
                className: "flex items-center gap-2"
            }, React.createElement("label", {
                className: "font-semibold"
            }, "📅 Período:"), React.createElement("select", {
                value: e,
                onChange: e => x({
                    ...p,
                    relMes: e.target.value
                }),
                className: "px-3 py-2 border rounded-lg"
            }, f.map((e, t) => React.createElement("option", {
                key: t,
                value: t
            }, e))), React.createElement("select", {
                value: t,
                onChange: e => x({
                    ...p,
                    relAno: e.target.value
                }),
                className: "px-3 py-2 border rounded-lg"
            }, [2024, 2025, 2026].map(e => React.createElement("option", {
                key: e,
                value: e
            }, e)))), React.createElement("button", {
                onClick: () => {
                    const m = `\n                  <html>\n                  <head>\n                    <title>Relatório Tutts - ${f[e]}/${t}</title>\n                    <style>\n                      body { font-family: Arial, sans-serif; padding: 20px; max-width: 800px; margin: 0 auto; }\n                      h1 { color: #581c87; border-bottom: 2px solid #581c87; padding-bottom: 10px; }\n                      h2 { color: #7c3aed; margin-top: 30px; }\n                      .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }\n                      .cards { display: grid; grid-template-columns: repeat(4, 1fr); gap: 15px; margin: 20px 0; }\n                      .card { background: #f3f4f6; padding: 15px; border-radius: 8px; text-align: center; }\n                      .card-value { font-size: 28px; font-weight: bold; }\n                      .green { color: #16a34a; }\n                      .red { color: #dc2626; }\n                      .yellow { color: #ca8a04; }\n                      .purple { color: #7c3aed; }\n                      table { width: 100%; border-collapse: collapse; margin: 15px 0; }\n                      th, td { border: 1px solid #ddd; padding: 10px; text-align: left; }\n                      th { background: #f3f4f6; }\n                      .footer { margin-top: 40px; text-align: center; color: #666; font-size: 12px; border-top: 1px solid #ddd; padding-top: 20px; }\n                      .comparativo { background: ${parseFloat(h)>=0?"#dcfce7":"#fee2e2"}; padding: 15px; border-radius: 8px; margin: 20px 0; }\n                    </style>\n                  </head>\n                  <body>\n                    <div class="header">\n                      <h1>📊 Relatório Tutts</h1>\n                      <div>\n                        <strong>${f[e]} / ${t}</strong><br>\n                        <small>Gerado em: ${(new Date).toLocaleString("pt-BR")}</small>\n                      </div>\n                    </div>\n                    \n                    <h2>📋 Resumo Geral</h2>\n                    <div class="cards">\n                      <div class="card"><div class="card-value purple">${a.length}</div><div>Total</div></div>\n                      <div class="card"><div class="card-value green">${l.length}</div><div>Aprovadas</div></div>\n                      <div class="card"><div class="card-value red">${r.length}</div><div>Rejeitadas</div></div>\n                      <div class="card"><div class="card-value yellow">${o.length}</div><div>Pendentes</div></div>\n                    </div>\n                    \n                    <div class="cards">\n                      <div class="card"><div class="card-value green">${c}%</div><div>Taxa Aprovação</div></div>\n                      <div class="card"><div class="card-value red">${s}%</div><div>Taxa Rejeição</div></div>\n                      <div class="card"><div class="card-value purple">${A.length}</div><div>Profissionais</div></div>\n                      <div class="card"><div class="card-value purple">${A.length>0?(a.length/A.length).toFixed(1):0}</div><div>Média/Profissional</div></div>\n                    </div>\n                    \n                    <div class="comparativo">\n                      <strong>📊 Comparativo com Mês Anterior:</strong> \n                      ${parseFloat(h)>=0?"📈":"📉"} ${parseFloat(h)>=0?"+":""}${h}% \n                      (${E.length} → ${a.length} solicitações)\n                    </div>\n                    \n                    <h2>📁 Por Motivo</h2>\n                    <table>\n                      <thead><tr><th>Motivo</th><th>Total</th><th>Aprovadas</th><th>Rejeitadas</th><th>Pendentes</th><th>Taxa</th></tr></thead>\n                      <tbody>\n                        ${Object.entries(n).map(([e,t])=>`\n                          <tr>\n                            <td>${e}</td>\n                            <td>${t.total}</td>\n                            <td class="green">${t.aprovadas}</td>\n                            <td class="red">${t.rejeitadas}</td>\n                            <td class="yellow">${t.pendentes}</td>\n                            <td>${t.total>0?(t.aprovadas/t.total*100).toFixed(0):0}%</td>\n                          </tr>\n                        `).join("")}\n                      </tbody>\n                    </table>\n                    \n                    <h2>👷 Top 10 Profissionais</h2>\n                    <table>\n                      <thead><tr><th>#</th><th>Profissional</th><th>Código</th><th>Total</th><th>Aprovadas</th><th>Rejeitadas</th><th>Taxa</th></tr></thead>\n                      <tbody>\n                        ${i.map((e,t)=>`\n                          <tr>\n                            <td>${t+1}</td>\n                            <td>${e.nome}</td>\n                            <td>${e.cod||"-"}</td>\n                            <td>${e.total}</td>\n                            <td class="green">${e.aprovadas}</td>\n                            <td class="red">${e.rejeitadas}</td>\n                            <td>${e.taxa}%</td>\n                          </tr>\n                        `).join("")}\n                      </tbody>\n                    </table>\n                    \n                    <h2>📅 Por Semana</h2>\n                    <table>\n                      <thead><tr><th>Semana</th><th>Total</th><th>Aprovadas</th><th>Taxa</th></tr></thead>\n                      <tbody>\n                        ${d.map(e=>`\n                          <tr>\n                            <td>${e.label} (dias ${e.dias[0]}-${e.dias[1]})</td>\n                            <td>${e.total}</td>\n                            <td class="green">${e.aprovadas}</td>\n                            <td>${e.total>0?(e.aprovadas/e.total*100).toFixed(0):0}%</td>\n                          </tr>\n                        `).join("")}\n                      </tbody>\n                    </table>\n                    \n                    <div class="footer">\n                      <strong>Central do Entregador Tutts</strong> - Relatório Gerado Automaticamente<br>\n                      ${(new Date).toLocaleString("pt-BR")}\n                    </div>\n                  </body>\n                  </html>\n                `,
                        p = window.open("", "_blank");
                    p.document.write(m), p.document.close(), p.print()
                },
                className: "ml-auto px-4 py-2 bg-red-600 text-white rounded-lg font-semibold hover:bg-red-700 flex items-center gap-2"
            }, "📄 Gerar PDF")), React.createElement("div", {
                className: "grid grid-cols-2 md:grid-cols-4 gap-4 mb-6"
            }, React.createElement("div", {
                className: "bg-white rounded-xl shadow p-4 border-l-4 border-purple-500"
            }, React.createElement("p", {
                className: "text-xs text-gray-500"
            }, "📋 Total Solicitações"), React.createElement("p", {
                className: "text-3xl font-bold text-purple-600"
            }, a.length)), React.createElement("div", {
                className: "bg-white rounded-xl shadow p-4 border-l-4 border-green-500"
            }, React.createElement("p", {
                className: "text-xs text-gray-500"
            }, "✅ Aprovadas"), React.createElement("p", {
                className: "text-3xl font-bold text-green-600"
            }, l.length)), React.createElement("div", {
                className: "bg-white rounded-xl shadow p-4 border-l-4 border-red-500"
            }, React.createElement("p", {
                className: "text-xs text-gray-500"
            }, "❌ Rejeitadas"), React.createElement("p", {
                className: "text-3xl font-bold text-red-600"
            }, r.length)), React.createElement("div", {
                className: "bg-white rounded-xl shadow p-4 border-l-4 border-yellow-500"
            }, React.createElement("p", {
                className: "text-xs text-gray-500"
            }, "⏳ Pendentes"), React.createElement("p", {
                className: "text-3xl font-bold text-yellow-600"
            }, o.length))), React.createElement("div", {
                className: "grid grid-cols-2 md:grid-cols-4 gap-4 mb-6"
            }, React.createElement("div", {
                className: "bg-green-50 rounded-xl p-4 text-center border border-green-200"
            }, React.createElement("p", {
                className: "text-3xl font-bold text-green-600"
            }, c, "%"), React.createElement("p", {
                className: "text-xs text-green-700"
            }, "Taxa de Aprovação")), React.createElement("div", {
                className: "bg-red-50 rounded-xl p-4 text-center border border-red-200"
            }, React.createElement("p", {
                className: "text-3xl font-bold text-red-600"
            }, s, "%"), React.createElement("p", {
                className: "text-xs text-red-700"
            }, "Taxa de Rejeição")), React.createElement("div", {
                className: "bg-purple-50 rounded-xl p-4 text-center border border-purple-200"
            }, React.createElement("p", {
                className: "text-3xl font-bold text-purple-600"
            }, A.length), React.createElement("p", {
                className: "text-xs text-purple-700"
            }, "Total Profissionais")), React.createElement("div", {
                className: "bg-blue-50 rounded-xl p-4 text-center border border-blue-200"
            }, React.createElement("p", {
                className: "text-3xl font-bold text-blue-600"
            }, A.length > 0 ? (a.length / A.length).toFixed(1) : 0), React.createElement("p", {
                className: "text-xs text-blue-700"
            }, "Média por Profissional"))), React.createElement("div", {
                className: "rounded-xl p-4 mb-6 " + (parseFloat(h) >= 0 ? "bg-green-50 border border-green-200" : "bg-red-50 border border-red-200")
            }, React.createElement("h3", {
                className: "font-semibold mb-2"
            }, "📊 Comparativo com Mês Anterior"), React.createElement("div", {
                className: "flex items-center gap-6"
            }, React.createElement("div", null, React.createElement("p", {
                className: "text-sm text-gray-600"
            }, "Mês anterior: ", React.createElement("strong", null, E.length), " solicitações"), React.createElement("p", {
                className: "text-sm text-gray-600"
            }, "Mês atual: ", React.createElement("strong", null, a.length), " solicitações")), React.createElement("div", {
                className: "text-3xl font-bold " + (parseFloat(h) >= 0 ? "text-green-600" : "text-red-600")
            }, parseFloat(h) >= 0 ? "📈" : "📉", " ", parseFloat(h) >= 0 ? "+" : "", h, "%"))), React.createElement("div", {
                className: "grid md:grid-cols-2 gap-6 mb-6"
            }, React.createElement("div", {
                className: "bg-white rounded-xl shadow p-6"
            }, React.createElement("h3", {
                className: "font-semibold mb-4"
            }, "📈 Evolução (Últimos 6 meses)"), React.createElement("div", {
                className: "flex items-end justify-between h-40 gap-2"
            }, g.map((e, t) => React.createElement("div", {
                key: t,
                className: "flex-1 flex flex-col items-center"
            }, React.createElement("div", {
                className: "w-full bg-gray-100 rounded-t relative",
                style: {
                    height: e.total / b * 100 + "%",
                    minHeight: "20px"
                }
            }, React.createElement("div", {
                className: "absolute inset-0 bg-gradient-to-t from-purple-600 to-purple-400 rounded-t"
            })), React.createElement("p", {
                className: "text-xs font-bold mt-1"
            }, e.total), React.createElement("p", {
                className: "text-xs text-gray-500"
            }, e.label))))), React.createElement("div", {
                className: "bg-white rounded-xl shadow p-6"
            }, React.createElement("h3", {
                className: "font-semibold mb-4"
            }, "📅 Por Semana (", f[e], ")"), React.createElement("div", {
                className: "flex items-end justify-between h-40 gap-2"
            }, d.map((e, t) => React.createElement("div", {
                key: t,
                className: "flex-1 flex flex-col items-center"
            }, React.createElement("div", {
                className: "w-full bg-gray-100 rounded-t relative",
                style: {
                    height: e.total / u * 100 + "%",
                    minHeight: "20px"
                }
            }, React.createElement("div", {
                className: "absolute inset-0 bg-gradient-to-t from-blue-600 to-blue-400 rounded-t"
            })), React.createElement("p", {
                className: "text-xs font-bold mt-1"
            }, e.total), React.createElement("p", {
                className: "text-xs text-gray-500"
            }, "Sem ", t + 1)))))), React.createElement("div", {
                className: "bg-white rounded-xl shadow p-6 mb-6"
            }, React.createElement("h3", {
                className: "font-semibold mb-4"
            }, "📁 Por Motivo"), React.createElement("div", {
                className: "overflow-x-auto"
            }, React.createElement("table", {
                className: "w-full text-sm"
            }, React.createElement("thead", {
                className: "bg-gray-50"
            }, React.createElement("tr", null, React.createElement("th", {
                className: "px-4 py-3 text-left"
            }, "Motivo"), React.createElement("th", {
                className: "px-4 py-3 text-center"
            }, "Total"), React.createElement("th", {
                className: "px-4 py-3 text-center"
            }, "✅ Aprovadas"), React.createElement("th", {
                className: "px-4 py-3 text-center"
            }, "❌ Rejeitadas"), React.createElement("th", {
                className: "px-4 py-3 text-center"
            }, "⏳ Pendentes"), React.createElement("th", {
                className: "px-4 py-3 text-center"
            }, "Taxa"))), React.createElement("tbody", null, Object.entries(n).sort((e, t) => t[1].total - e[1].total).map(([e, t]) => React.createElement("tr", {
                key: e,
                className: "border-t hover:bg-gray-50"
            }, React.createElement("td", {
                className: "px-4 py-3 font-semibold"
            }, e), React.createElement("td", {
                className: "px-4 py-3 text-center font-bold"
            }, t.total), React.createElement("td", {
                className: "px-4 py-3 text-center text-green-600 font-semibold"
            }, t.aprovadas), React.createElement("td", {
                className: "px-4 py-3 text-center text-red-600 font-semibold"
            }, t.rejeitadas), React.createElement("td", {
                className: "px-4 py-3 text-center text-yellow-600 font-semibold"
            }, t.pendentes), React.createElement("td", {
                className: "px-4 py-3 text-center"
            }, React.createElement("span", {
                className: "px-2 py-1 rounded text-xs font-bold " + (t.total > 0 && t.aprovadas / t.total >= .7 ? "bg-green-100 text-green-700" : t.total > 0 && t.aprovadas / t.total >= .4 ? "bg-yellow-100 text-yellow-700" : "bg-red-100 text-red-700")
            }, t.total > 0 ? (t.aprovadas / t.total * 100).toFixed(0) : 0, "%")))))))), React.createElement("div", {
                className: "bg-white rounded-xl shadow p-6"
            }, React.createElement("h3", {
                className: "font-semibold mb-4"
            }, "👷 Top 10 Profissionais do Mês"), React.createElement("div", {
                className: "overflow-x-auto"
            }, React.createElement("table", {
                className: "w-full text-sm"
            }, React.createElement("thead", {
                className: "bg-gray-50"
            }, React.createElement("tr", null, React.createElement("th", {
                className: "px-4 py-3 text-center"
            }, "#"), React.createElement("th", {
                className: "px-4 py-3 text-left"
            }, "Profissional"), React.createElement("th", {
                className: "px-4 py-3 text-left"
            }, "Código"), React.createElement("th", {
                className: "px-4 py-3 text-center"
            }, "Total"), React.createElement("th", {
                className: "px-4 py-3 text-center"
            }, "✅"), React.createElement("th", {
                className: "px-4 py-3 text-center"
            }, "❌"), React.createElement("th", {
                className: "px-4 py-3 text-center"
            }, "Taxa"))), React.createElement("tbody", null, i.map((e, t) => React.createElement("tr", {
                key: t,
                className: "border-t hover:bg-gray-50 " + (t < 3 ? "bg-yellow-50" : "")
            }, React.createElement("td", {
                className: "px-4 py-3 text-center"
            }, 0 === t ? "🥇" : 1 === t ? "🥈" : 2 === t ? "🥉" : t + 1), React.createElement("td", {
                className: "px-4 py-3 font-semibold"
            }, e.nome), React.createElement("td", {
                className: "px-4 py-3 font-mono text-gray-600"
            }, e.cod || "-"), React.createElement("td", {
                className: "px-4 py-3 text-center font-bold"
            }, e.total), React.createElement("td", {
                className: "px-4 py-3 text-center text-green-600 font-semibold"
            }, e.aprovadas), React.createElement("td", {
                className: "px-4 py-3 text-center text-red-600 font-semibold"
            }, e.rejeitadas), React.createElement("td", {
                className: "px-4 py-3 text-center"
            }, React.createElement("span", {
                className: "px-2 py-1 rounded text-xs font-bold " + (parseInt(e.taxa) >= 70 ? "bg-green-100 text-green-700" : parseInt(e.taxa) >= 40 ? "bg-yellow-100 text-yellow-700" : "bg-red-100 text-red-700")
            }, e.taxa, "%")))))))))
        })(), "users" === p.adminTab && React.createElement("div", {
            className: "bg-white rounded-xl shadow p-6"
        }, React.createElement("h2", {
            className: "text-lg font-semibold mb-4"
        }, "👥 Gerenciar Usuários"), React.createElement("div", {
            className: "bg-purple-50 border border-purple-200 rounded-lg p-4 mb-6"
        }, React.createElement("h3", {
            className: "font-semibold mb-3"
        }, "➕ Criar Usuário"), React.createElement("div", {
            className: "space-y-4"
        }, React.createElement("div", {
            className: "grid md:grid-cols-2 gap-4"
        }, React.createElement("div", null, React.createElement("label", {
            className: "block text-sm font-semibold mb-1"
        }, "Nome"), React.createElement("input", {
            type: "text",
            value: p.newName || "",
            onChange: e => x({
                ...p,
                newName: e.target.value
            }),
            className: "w-full px-3 py-2 border rounded"
        })), React.createElement("div", null, React.createElement("label", {
            className: "block text-sm font-semibold mb-1"
        }, "Código"), React.createElement("input", {
            type: "text",
            value: p.newCod || "",
            onChange: e => x({
                ...p,
                newCod: e.target.value
            }),
            className: "w-full px-3 py-2 border rounded"
        }))), React.createElement("div", {
            className: "grid md:grid-cols-2 gap-4"
        }, React.createElement("div", null, React.createElement("label", {
            className: "block text-sm font-semibold mb-1"
        }, "Senha"), React.createElement("input", {
            type: "password",
            value: p.newPass || "",
            onChange: e => x({
                ...p,
                newPass: e.target.value
            }),
            className: "w-full px-3 py-2 border rounded"
        })), React.createElement("div", null, React.createElement("label", {
            className: "block text-sm font-semibold mb-1"
        }, "Tipo"), React.createElement("select", {
            value: p.newRole || "user",
            onChange: e => x({
                ...p,
                newRole: e.target.value
            }),
            className: "w-full px-3 py-2 border rounded bg-white"
        }, React.createElement("option", {
            value: "user"
        }, "👤 Usuário"), React.createElement("option", {
            value: "admin"
        }, "👑 Admin"), React.createElement("option", {
            value: "admin_financeiro"
        }, "💰 Admin Financeiro")))), React.createElement("button", {
            onClick: async () => {
                if (p.newName && p.newCod && p.newPass) {
                    s(!0);
                    try {
                        await fetch(`${API_URL}/users/register`, {
                            method: "POST",
                            headers: {
                                "Content-Type": "application/json"
                            },
                            body: JSON.stringify({
                                fullName: p.newName,
                                codProfissional: p.newCod,
                                password: p.newPass,
                                role: p.newRole || "user"
                            })
                        }), ja("✅ Criado!", "success"), x({
                            ...p,
                            newName: "",
                            newCod: "",
                            newPass: "",
                            newRole: "user"
                        }), Ia()
                    } catch {
                        ja("Erro", "error")
                    }
                    s(!1)
                } else ja("Preencha todos", "error")
            },
            className: "w-full px-6 py-2 bg-purple-600 text-white rounded font-semibold"
        }, "➕ Criar Usuário"))), React.createElement("h3", {
            className: "font-semibold mb-3"
        }, "📋 Usuários Cadastrados (", A.length, ")"), React.createElement("div", {
            className: "space-y-2"
        }, A.map(e => React.createElement("div", {
            key: e.codProfissional,
            className: "border rounded-lg p-4 flex items-center justify-between hover:bg-gray-50"
        }, React.createElement("div", {
            className: "flex-1"
        }, React.createElement("p", {
            className: "font-semibold"
        }, e.fullName), React.createElement("p", {
            className: "text-sm text-gray-600"
        }, "COD: ", e.codProfissional, " • ", e.role), React.createElement("p", {
            className: "text-xs text-gray-400"
        }, e.createdAt)), React.createElement("div", {
            className: "flex gap-2 items-center"
        }, React.createElement("input", {
            type: "password",
            placeholder: "Nova senha",
            value: p[`newpass_${e.codProfissional}`] || "",
            onChange: t => x({
                ...p,
                [`newpass_${e.codProfissional}`]: t.target.value
            }),
            className: "px-3 py-2 border rounded text-sm w-32"
        }), React.createElement("button", {
            onClick: async () => {
                const t = p[`newpass_${e.codProfissional}`];
                !t || t.length < 4 ? ja("Senha muito curta", "error") : (await fetch(`${API_URL}/users/reset-password`, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({
                        codProfissional: e.codProfissional,
                        newPassword: t
                    })
                }), ja("✅ Senha alterada!", "success"), x({
                    ...p,
                    [`newpass_${e.codProfissional}`]: ""
                }))
            },
            className: "px-4 py-2 bg-purple-600 text-white rounded text-sm font-semibold"
        }, "🔑 Resetar"), React.createElement("button", {
            onClick: async () => {
                const t = `⚠️ ATENÇÃO!\n\nExcluir ${e.fullName} (${e.codProfissional})?\n\nTODOS os dados associados serão excluídos:\n• Solicitações de saque\n• Histórico de saques\n• Gratuidades\n• Indicações\n• Inscrições em promoções\n• Respostas do quiz\n\nEsta ação NÃO pode ser desfeita!`;
                if (confirm(t)) {
                    try {
                        const t = await fetch(`${API_URL}/users/${e.codProfissional}`, {
                                method: "DELETE"
                            }),
                            a = await t.json();
                        if (!t.ok) throw new Error(a.error);
                        {
                            const e = a.deleted;
                            ja(`🗑️ Excluído! (${e.submissions} solicitações, ${e.withdrawals} saques, ${e.gratuities} gratuidades, ${e.indicacoes} indicações)`, "success")
                        }
                    } catch (e) {
                        ja("❌ Erro ao excluir: " + e.message, "error")
                    }
                    Ia()
                }
            },
            className: "px-4 py-2 bg-red-600 text-white rounded text-sm font-semibold"
        }, "🗑️"))))))))
    };
// Modal de Configurações - Componente Separado
const ConfigModal = ({show, onClose, users, loadUsers, showToast, setLoading, currentUser, state, setState}) => {
    if (!show || currentUser?.role !== "admin_master") return null;
    
    const [configTab, setConfigTab] = React.useState("usuarios");
    const [newName, setNewName] = React.useState("");
    const [newCod, setNewCod] = React.useState("");
    const [newPass, setNewPass] = React.useState("");
    const [newRole, setNewRole] = React.useState("user");
    const [adminPerms, setAdminPerms] = React.useState({});
    
    const createUser = async () => {
        if (!newName || !newCod || !newPass) {
            showToast("Preencha todos os campos", "error");
            return;
        }
        setLoading(true);
        try {
            await fetch(API_URL + "/users/register", {
                method: "POST",
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify({fullName: newName, codProfissional: newCod, password: newPass, role: newRole})
            });
            showToast("✅ Usuário criado!", "success");
            setNewName(""); setNewCod(""); setNewPass(""); setNewRole("user");
            loadUsers();
        } catch (err) {
            showToast("Erro ao criar usuário", "error");
        }
        setLoading(false);
    };
    
    const resetPassword = async (user) => {
        const newPass = prompt("Nova senha para " + user.fullName + ":");
        if (newPass && newPass.length >= 4) {
            await fetch(API_URL + "/users/reset-password", {
                method: "POST",
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify({codProfissional: user.codProfissional, newPassword: newPass})
            });
            showToast("✅ Senha alterada!", "success");
        } else if (newPass) {
            showToast("Senha muito curta (mín. 4 caracteres)", "error");
        }
    };
    
    const deleteUser = async (user) => {
        if (confirm("⚠️ Excluir " + user.fullName + " (" + user.codProfissional + ")?\\n\\nEsta ação não pode ser desfeita!")) {
            try {
                await fetch(API_URL + "/users/" + user.codProfissional, {method: "DELETE"});
                showToast("🗑️ Usuário excluído!", "success");
                loadUsers();
            } catch (err) {
                showToast("Erro ao excluir", "error");
            }
        }
    };
    
    const toggleAdminPerm = (cod, module) => {
        setAdminPerms(prev => ({
            ...prev,
            [cod]: {
                ...prev[cod],
                [module]: !(prev[cod]?.[module] !== false)
            }
        }));
    };
    
    const savePermissions = async () => {
        // Salvar permissões no backend
        for (const cod in adminPerms) {
            try {
                await fetch(API_URL + "/admin-permissions/" + cod, {
                    method: "PUT",
                    headers: {"Content-Type": "application/json"},
                    body: JSON.stringify({
                        ativo: adminPerms[cod]?.ativo !== false,
                        modulos: adminPerms[cod] || {}
                    })
                });
            } catch (err) {
                console.error("Erro ao salvar permissões:", err);
            }
        }
        showToast("✅ Permissões salvas!", "success");
    };
    
    return React.createElement("div", {
        className: "fixed inset-0 bg-black bg-opacity-60 z-[9999] flex items-center justify-center p-4",
        onClick: onClose
    }, React.createElement("div", {
        className: "bg-white rounded-2xl shadow-2xl w-full max-w-4xl max-h-[90vh] overflow-hidden",
        onClick: e => e.stopPropagation()
    },
        // Header
        React.createElement("div", {className: "bg-gradient-to-r from-purple-700 to-purple-900 text-white p-4"},
            React.createElement("div", {className: "flex items-center justify-between"},
                React.createElement("div", {className: "flex items-center gap-3"},
                    React.createElement("span", {className: "text-2xl"}, "⚙️"),
                    React.createElement("div", null,
                        React.createElement("h2", {className: "text-lg font-bold"}, "Configurações do Sistema"),
                        React.createElement("p", {className: "text-purple-200 text-sm"}, "Gestão de usuários e permissões")
                    )
                ),
                React.createElement("button", {onClick: onClose, className: "text-white/80 hover:text-white text-2xl font-bold"}, "✕")
            )
        ),
        // Tabs
        React.createElement("div", {className: "border-b"},
            React.createElement("div", {className: "flex gap-1 px-4"},
                React.createElement("button", {
                    onClick: () => setConfigTab("usuarios"),
                    className: "px-4 py-3 text-sm font-semibold " + (configTab === "usuarios" ? "text-purple-700 border-b-2 border-purple-600" : "text-gray-500 hover:text-gray-700")
                }, "👥 Gerenciar Usuários"),
                React.createElement("button", {
                    onClick: () => setConfigTab("permissoes"),
                    className: "px-4 py-3 text-sm font-semibold " + (configTab === "permissoes" ? "text-purple-700 border-b-2 border-purple-600" : "text-gray-500 hover:text-gray-700")
                }, "🔐 Permissões ADM")
            )
        ),
        // Content
        React.createElement("div", {className: "p-6 overflow-y-auto", style: {maxHeight: "calc(90vh - 140px)"}},
            // Tab Usuários
            configTab === "usuarios" && React.createElement("div", null,
                // Criar usuário
                React.createElement("div", {className: "bg-purple-50 border border-purple-200 rounded-lg p-4 mb-6"},
                    React.createElement("h3", {className: "font-semibold mb-3"}, "➕ Criar Novo Usuário"),
                    React.createElement("div", {className: "grid md:grid-cols-2 gap-4 mb-4"},
                        React.createElement("div", null,
                            React.createElement("label", {className: "block text-sm font-semibold mb-1"}, "Nome Completo"),
                            React.createElement("input", {type: "text", value: newName, onChange: e => setNewName(e.target.value), className: "w-full px-3 py-2 border rounded", placeholder: "Ex: João Silva"})
                        ),
                        React.createElement("div", null,
                            React.createElement("label", {className: "block text-sm font-semibold mb-1"}, "Código Profissional"),
                            React.createElement("input", {type: "text", value: newCod, onChange: e => setNewCod(e.target.value), className: "w-full px-3 py-2 border rounded", placeholder: "Ex: 12345"})
                        )
                    ),
                    React.createElement("div", {className: "grid md:grid-cols-2 gap-4 mb-4"},
                        React.createElement("div", null,
                            React.createElement("label", {className: "block text-sm font-semibold mb-1"}, "Senha"),
                            React.createElement("input", {type: "password", value: newPass, onChange: e => setNewPass(e.target.value), className: "w-full px-3 py-2 border rounded", placeholder: "Mínimo 4 caracteres"})
                        ),
                        React.createElement("div", null,
                            React.createElement("label", {className: "block text-sm font-semibold mb-1"}, "Tipo de Usuário"),
                            React.createElement("select", {value: newRole, onChange: e => setNewRole(e.target.value), className: "w-full px-3 py-2 border rounded bg-white"},
                                React.createElement("option", {value: "user"}, "👤 Usuário Comum"),
                                React.createElement("option", {value: "admin"}, "👑 Administrador"),
                                React.createElement("option", {value: "admin_financeiro"}, "💰 Admin Financeiro")
                            )
                        )
                    ),
                    React.createElement("button", {onClick: createUser, className: "w-full px-6 py-2 bg-purple-600 text-white rounded font-semibold hover:bg-purple-700"}, "➕ Criar Usuário")
                ),
                // Lista de usuários
                React.createElement("h3", {className: "font-semibold mb-3"}, "📋 Usuários Cadastrados (", users.length, ")"),
                React.createElement("div", {className: "space-y-2", style: {maxHeight: "350px", overflowY: "auto"}},
                    users.map(user => React.createElement("div", {
                        key: user.codProfissional,
                        className: "border rounded-lg p-3 flex items-center justify-between hover:bg-gray-50"
                    },
                        React.createElement("div", null,
                            React.createElement("p", {className: "font-semibold"}, user.fullName),
                            React.createElement("p", {className: "text-sm text-gray-600"}, 
                                "COD: ", user.codProfissional, " • ",
                                user.role === "admin_master" ? "👑 Master" : 
                                user.role === "admin" ? "👑 Admin" : 
                                user.role === "admin_financeiro" ? "💰 Financeiro" : "👤 Usuário"
                            )
                        ),
                        React.createElement("div", {className: "flex gap-2"},
                            React.createElement("button", {
                                onClick: () => resetPassword(user),
                                className: "px-3 py-1 bg-blue-600 text-white rounded text-sm hover:bg-blue-700"
                            }, "🔑 Senha"),
                            user.role !== "admin_master" && React.createElement("button", {
                                onClick: () => deleteUser(user),
                                className: "px-3 py-1 bg-red-600 text-white rounded text-sm hover:bg-red-700"
                            }, "🗑️")
                        )
                    ))
                )
            ),
            // Tab Permissões
            configTab === "permissoes" && React.createElement("div", null,
                React.createElement("div", {className: "bg-blue-50 border border-blue-200 rounded-lg p-4 mb-6"},
                    React.createElement("h3", {className: "font-semibold text-blue-800 mb-2"}, "🔐 Sistema de Permissões"),
                    React.createElement("p", {className: "text-sm text-blue-600"}, "Configure quais módulos cada administrador pode acessar. Clique nos módulos para ativar/desativar.")
                ),
                React.createElement("h3", {className: "font-semibold mb-3"}, "👑 Administradores"),
                users.filter(u => u.role === "admin" || u.role === "admin_financeiro").length === 0
                    ? React.createElement("p", {className: "text-gray-500 text-center py-4"}, "Nenhum administrador cadastrado (exceto Master)")
                    : React.createElement("div", {className: "space-y-4"},
                        users.filter(u => u.role === "admin" || u.role === "admin_financeiro").map(admin => 
                            React.createElement("div", {key: admin.codProfissional, className: "border rounded-xl p-4 bg-white shadow-sm"},
                                React.createElement("div", {className: "flex items-center justify-between mb-4"},
                                    React.createElement("div", null,
                                        React.createElement("p", {className: "font-bold text-lg"}, admin.fullName),
                                        React.createElement("p", {className: "text-sm text-gray-500"}, 
                                            "COD: ", admin.codProfissional, " • ",
                                            admin.role === "admin" ? "👑 Admin" : "💰 Admin Financeiro"
                                        )
                                    ),
                                    React.createElement("button", {
                                        onClick: () => {
                                            setAdminPerms(prev => ({
                                                ...prev,
                                                [admin.codProfissional]: {
                                                    ...prev[admin.codProfissional],
                                                    ativo: !(prev[admin.codProfissional]?.ativo !== false)
                                                }
                                            }));
                                        },
                                        className: "px-3 py-1 rounded-full text-xs font-bold " + 
                                            ((adminPerms[admin.codProfissional]?.ativo !== false) 
                                                ? "bg-green-100 text-green-700 hover:bg-green-200" 
                                                : "bg-red-100 text-red-700 hover:bg-red-200")
                                    }, (adminPerms[admin.codProfissional]?.ativo !== false) ? "✅ Ativo" : "❌ Inativo")
                                ),
                                React.createElement("p", {className: "text-sm font-semibold mb-2"}, "📱 Módulos (clique para alternar):"),
                                React.createElement("div", {className: "grid grid-cols-2 md:grid-cols-3 gap-2"},
                                    [
                                        {id: "solicitacoes", label: "📋 Solicitações", icon: "📋"},
                                        {id: "financeiro", label: "💰 Financeiro", icon: "💰"},
                                        {id: "operacional", label: "⚙️ Operacional", icon: "⚙️"},
                                        {id: "disponibilidade", label: "📅 Disponibilidade", icon: "📅"},
                                        {id: "bi", label: "📊 BI/Relatórios", icon: "📊"},
                                        {id: "todo", label: "📝 TO-DO", icon: "📝"}
                                    ].map(mod => React.createElement("button", {
                                        key: mod.id,
                                        onClick: () => toggleAdminPerm(admin.codProfissional, mod.id),
                                        className: "flex items-center gap-2 p-2 rounded-lg border text-left text-sm transition-all " +
                                            ((adminPerms[admin.codProfissional]?.[mod.id] !== false)
                                                ? "border-green-300 bg-green-50 text-green-700 hover:bg-green-100"
                                                : "border-gray-200 bg-gray-50 text-gray-500 hover:bg-gray-100")
                                    },
                                        React.createElement("span", null, mod.icon),
                                        React.createElement("span", null, mod.label.split(" ")[1] || mod.label)
                                    ))
                                )
                            )
                        )
                    ),
                React.createElement("div", {className: "flex justify-end mt-6"},
                    React.createElement("button", {
                        onClick: savePermissions,
                        className: "px-6 py-3 bg-purple-600 text-white rounded-lg font-semibold hover:bg-purple-700"
                    }, "💾 Salvar Permissões")
                )
            )
        )
    ));
};
ReactDOM.render(React.createElement(App, null), document.getElementById("root"), hideLoadingScreen);
