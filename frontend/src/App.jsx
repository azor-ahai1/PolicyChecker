import { useRef, useState } from "react";
import axios from "axios";

function App() {
  const fileInputRef = useRef(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [selectedFile, setSelectedFile] = useState(null);
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState(false);

  const [result, setResult] = useState(null); // holds response.data.data from backend
  const [info, setInfo] = useState("");

  const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

  const handleFileClick = () => fileInputRef.current.click();

  const handleFileChange = (e) => {
    const file = e.target.files[0];
    validateAndSetFile(file);
  };

  const validateAndSetFile = (file) => {
    setError("");
    setInfo("");
    if (!file) {
      setSelectedFile(null);
      return;
    }
    if (file.type !== "application/pdf") {
      setSelectedFile(null);
      setError("Invalid file type — please upload a PDF.");
      return;
    }
    if (file.size > MAX_FILE_SIZE) {
      setSelectedFile(null);
      setError(`File is too large — max ${MAX_FILE_SIZE / 1024 / 1024} MB.`);
      return;
    }
    setSelectedFile(file);
    setError("");
  };

  // drag/drop
  const handleDragOver = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  };
  const handleDragLeave = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  };
  const handleDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    const files = e.dataTransfer.files;
    if (files.length > 0) validateAndSetFile(files[0]);
  };

  // Upload & process
  const uploadFile = async () => {
    if (!selectedFile) {
      setError("No file selected");
      return;
    }
    setUploading(true);
    setError("");
    setInfo("");
    setResult(null);
    try {
      const fd = new FormData();
      fd.append("questions", selectedFile);

      const res = await axios.post(`${import.meta.env.VITE_BACKEND_URL}/api/v1/process`, fd, {
        headers: { "Content-Type": "multipart/form-data" }
      });

      if (res.data && res.data.success) {
        const data = res.data.data;
        setResult(data);
        console.log(data);
        setInfo("Processing complete — review the compliance results below.");
      } else {
        setError(res.data?.message || "Unexpected response from server");
      }
    } catch (err) {
      console.error(err);
      setError(err.response?.data?.message || err.message || "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  const clearFile = () => {
    setSelectedFile(null);
    setError("");
    setInfo("");
    setResult(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const getComplianceStats = () => {
    if (!result || !result.questions) return null;
    
    const total = result.questions.length;
    const answered = result.questions.filter(q => {
      const evidence = result.evidenceByQuestion?.[q.id];
      return evidence && evidence.length > 0;
    }).length;
    const yesAnswers = result.questions.filter(q => {
      const evidence = result.evidenceByQuestion?.[q.id];
      return evidence && evidence.length > 0 && evidence[0].answer === 'yes';
    }).length;
    
    return {
      total,
      answered,
      yesAnswers,
      noAnswers: answered - yesAnswers,
      unanswered: total - answered,
      complianceRate: total > 0 ? Math.round((yesAnswers / total) * 100) : 0,
      coverageRate: total > 0 ? Math.round((answered / total) * 100) : 0
    };
  };

  const stats = getComplianceStats();

  return (
    <div className="min-h-screen bg-gradient-to-b from-white to-slate-50 flex flex-col">
      <header className="max-w-6xl mx-auto w-full p-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-indigo-600 flex items-center justify-center text-white font-bold">AC</div>
          <div>
            <h1 className="text-lg font-semibold">Audit Compliance Matcher</h1>
            <p className="text-xs text-slate-500">Automated compliance verification for audit requirements</p>
          </div>
        </div>
      </header>

      <main className="flex w-full">
        <section className="mx-auto px-6 py-12 grid gap-10 items-center w-full max-w-6xl">
          <div className="bg-white rounded-xl shadow p-6">
            <div className="text-slate-500 text-sm">Upload your audit questions PDF</div>

            <div
              id="upload"
              className={`mt-4 border-2 border-dashed p-6 rounded-md text-center transition-colors ${isDragOver ? "border-indigo-400 bg-indigo-50" : "border-slate-200"}`}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
            >
              {selectedFile ? (
                <div className="text-left">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-green-700 font-medium">✓ {selectedFile.name}</div>
                      <div className="text-xs text-green-600 mt-1">File ready ({(selectedFile.size / 1024 / 1024).toFixed(2)} MB)</div>
                    </div>

                    <div className="flex gap-2">
                      <button onClick={clearFile} className="px-3 py-1 bg-gray-100 rounded-md text-sm hover:bg-gray-200">Remove</button>
                      <button onClick={uploadFile} disabled={uploading} className="px-4 py-2 bg-indigo-600 text-white rounded-md hover:bg-indigo-700 disabled:opacity-60">
                        {uploading ? "Processing..." : "Analyze Compliance"}
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <>
                  <div className="text-slate-700 font-medium">Drag & drop your audit questions PDF here</div>
                  <div className="text-xs text-slate-400 mt-2">We'll extract questions and find compliance evidence in your policy documents.</div>

                  <div className="mt-4 flex items-center justify-center gap-3">
                    <button onClick={handleFileClick} className="px-4 py-2 bg-indigo-600 text-white rounded-md hover:bg-indigo-700 transition-colors">Choose file</button>
                    <div className="text-xs text-slate-500">or drop a file into this box</div>
                  </div>
                </>
              )}

              <input type="file" accept="application/pdf" ref={fileInputRef} onChange={handleFileChange} className="hidden" />
            </div>

            <div className="mt-3 min-h-[1.2rem]">
              {error ? (
                <div className="text-sm text-red-600">{error}</div>
              ) : info ? (
                <div className="text-sm text-green-600">{info}</div>
              ) : selectedFile ? (
                <div className="text-sm text-slate-600">File validated — ready to analyze.</div>
              ) : (
                <div className="text-sm text-slate-500">Accepted format: PDF. Max size: 10 MB.</div>
              )}
            </div>

            <div className="mt-4 text-xs text-slate-500">
              <strong>Note:</strong> Ensure your policy documents are accessible and properly indexed for accurate compliance matching.
            </div>
          </div>

          {/* Results & Compliance Status */}
          {result && stats && (
            <div className="bg-white rounded-xl shadow p-6">
              <div className="flex items-center justify-between mb-6">
                <div>
                  <h2 className="text-lg font-semibold">Compliance Analysis Results</h2>
                  <div className="text-xs text-slate-500">Automated compliance verification results</div>
                </div>
                <div className="grid grid-cols-4 gap-4 text-center">
                  <div className="bg-green-50 rounded-lg p-3">
                    <div className="text-2xl font-bold text-green-600">{stats.yesAnswers}</div>
                    <div className="text-xs text-green-700">Compliant</div>
                  </div>
                  <div className="bg-red-50 rounded-lg p-3">
                    <div className="text-2xl font-bold text-red-600">{stats.noAnswers}</div>
                    <div className="text-xs text-red-700">Non-Compliant</div>
                  </div>
                  <div className="bg-yellow-50 rounded-lg p-3">
                    <div className="text-2xl font-bold text-yellow-600">{stats.unanswered}</div>
                    <div className="text-xs text-yellow-700">No Evidence</div>
                  </div>
                  <div className="bg-blue-50 rounded-lg p-3">
                    <div className="text-2xl font-bold text-blue-600">{stats.complianceRate}%</div>
                    <div className="text-xs text-blue-700">Compliance Rate</div>
                  </div>
                </div>
              </div>

              {(result.questions || []).map((q) => {
                const evidence = result.evidenceByQuestion?.[q.id] || result.evidenceByQuestion?.[String(q.id)] || [];
                const bestMatch = evidence.length > 0 ? evidence[0] : null;
                
                return (
                  <div key={q.id} className="border-t pt-4 mt-4">
                    <div className="flex items-start gap-4">
                      <div className="flex-1">
                        <div className="font-medium text-slate-800 mb-2">
                          <span className="text-indigo-600">{q.id}.</span> {q.text}
                        </div>
                        
                        {bestMatch ? (
                          <div className="bg-slate-50 rounded-lg p-4">
                            <div className="flex items-center gap-3 mb-2">
                              <span className={`px-3 py-1 rounded-full text-sm font-medium ${
                                bestMatch.answer === 'yes' 
                                  ? 'bg-green-100 text-green-800' 
                                  : 'bg-red-100 text-red-800'
                              }`}>
                                {bestMatch.answer === 'yes' ? 'YES' : 'NO'}
                              </span>
                              <span className="text-sm font-medium text-slate-700">{bestMatch.docName}</span>
                              <span className={`px-2 py-1 rounded text-xs ${
                                bestMatch.confidence === 'high' ? 'bg-green-100 text-green-700' :
                                bestMatch.confidence === 'medium' ? 'bg-yellow-100 text-yellow-700' :
                                'bg-gray-100 text-gray-700'
                              }`}>
                                {bestMatch.confidence} confidence
                              </span>
                            </div>
                            
                            <div className="text-sm text-slate-700 mb-2">
                              <strong>Citation:</strong>
                            </div>
                            <div className="text-sm text-slate-600 bg-white p-3 rounded border-l-4 border-indigo-200">
                              "{bestMatch.evidence}"
                            </div>
                            
                            {bestMatch.pageReference && (
                              <div className="text-xs text-slate-500 mt-2">
                                <strong>Reference:</strong> {bestMatch.pageReference}
                              </div>
                            )}
                            
                            {bestMatch.explanation && (
                              <div className="text-xs text-slate-600 mt-2">
                                <strong>Analysis:</strong> {bestMatch.explanation}
                              </div>
                            )}
                          </div>
                        ) : (
                          <div className="bg-yellow-50 rounded-lg p-4 border border-yellow-200">
                            <div className="flex items-center gap-2 text-yellow-700">
                              <span className="text-lg">⚠️</span>
                              <span className="font-medium">No Evidence Found</span>
                            </div>
                            <div className="text-sm text-yellow-600 mt-1">
                              No policy documentation was found that addresses this requirement.
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}

              <div className="mt-6 pt-4 border-t flex gap-3">
                <button 
                  onClick={() => { setResult(null); setSelectedFile(null); clearFile(); }} 
                  className="px-4 py-2 bg-gray-100 rounded-md hover:bg-gray-200"
                >
                  Analyze New Document
                </button>
                <div className="text-sm text-slate-500 flex items-center">
                  Analysis completed for {result.questions?.length || 0} requirements from {result.meta?.originalFilename}
                </div>
              </div>

              {error && <div className="mt-3 text-sm text-red-600">{error}</div>}
              {info && <div className="mt-3 text-sm text-green-600">{info}</div>}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

export default App;










// import { useRef, useState } from "react";
// import axios from "axios";

// function App() {
//   const fileInputRef = useRef(null);
//   const [isDragOver, setIsDragOver] = useState(false);
//   const [selectedFile, setSelectedFile] = useState(null);
//   const [error, setError] = useState("");
//   const [uploading, setUploading] = useState(false);

//   const [result, setResult] = useState(null); // holds response.data.data from backend
//   const [selections, setSelections] = useState({}); // { questionId: selectedIndex | "nomatch" }
//   const [saving, setSaving] = useState(false);
//   const [info, setInfo] = useState("");

//   const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

//   const handleFileClick = () => fileInputRef.current.click();

//   const handleFileChange = (e) => {
//     const file = e.target.files[0];
//     validateAndSetFile(file);
//   };

//   const validateAndSetFile = (file) => {
//     setError("");
//     setInfo("");
//     if (!file) {
//       setSelectedFile(null);
//       return;
//     }
//     if (file.type !== "application/pdf") {
//       setSelectedFile(null);
//       setError("Invalid file type — please upload a PDF.");
//       return;
//     }
//     if (file.size > MAX_FILE_SIZE) {
//       setSelectedFile(null);
//       setError(`File is too large — max ${MAX_FILE_SIZE / 1024 / 1024} MB.`);
//       return;
//     }
//     setSelectedFile(file);
//     setError("");
//   };

//   // drag/drop
//   const handleDragOver = (e) => {
//     e.preventDefault();
//     e.stopPropagation();
//     setIsDragOver(true);
//   };
//   const handleDragLeave = (e) => {
//     e.preventDefault();
//     e.stopPropagation();
//     setIsDragOver(false);
//   };
//   const handleDrop = (e) => {
//     e.preventDefault();
//     e.stopPropagation();
//     setIsDragOver(false);
//     const files = e.dataTransfer.files;
//     if (files.length > 0) validateAndSetFile(files[0]);
//   };

//   // Upload & process
//   const uploadFile = async () => {
//     if (!selectedFile) {
//       setError("No file selected");
//       return;
//     }
//     setUploading(true);
//     setError("");
//     setInfo("");
//     setResult(null);
//     setSelections({});
//     try {
//       const fd = new FormData();
//       fd.append("questions", selectedFile);

//       const res = await axios.post("http://localhost:4000/api/v1/process", fd, {
//         headers: { "Content-Type": "multipart/form-data" },
//         timeout: 100000000,
//       });

//       if (res.data && res.data.success) {
//         const data = res.data.data;
//         setResult(data);
//         console.log(data);
//         // initialize selections to "nomatch" for each question
//         const init = {};
//         (data.questions || []).forEach((q) => {
//           init[q.id] = "nomatch";
//         });
//         setSelections(init);
//         setInfo("Processing complete — review the candidate excerpts below.");
//       } else {
//         setError(res.data?.message || "Unexpected response from server");
//       }
//     } catch (err) {
//       console.error(err);
//       setError(err.response?.data?.message || err.message || "Upload failed");
//     } finally {
//       setUploading(false);
//     }
//   };

//   // Select a candidate (or 'nomatch')
//   const choose = (questionId, idxOrNoMatch) => {
//     setSelections((s) => ({ ...s, [questionId]: idxOrNoMatch }));
//   };

//   // Submit matches to backend
//   const submitMatches = async () => {
//     if (!result) return setError("Nothing to submit");
//     setSaving(true);
//     setError("");
//     setInfo("");
//     try {
//       const matches = (result.questions || []).map((q) => {
//         const sel = selections[q.id];
//         const candidates = result.candidatesByQuestion?.[q.id] ?? result.candidatesByQuestion?.[String(q.id)] ?? [];
//         const selectedCandidate = sel === "nomatch" || sel == null ? null : candidates[sel] ?? null;
//         return {
//           questionId: q.id,
//           question: q.text,
//           selectedIndex: sel === "nomatch" ? null : sel,
//           selectedCandidate,
//         };
//       });

//       const payload = {
//         auditMeta: result.meta || {},
//         matches,
//       };

//       const res = await axios.post("http://localhost:4000/api/v1/submit-matches", payload, {
//         headers: { "Content-Type": "application/json" },
//         timeout: 60000,
//       });

//       if (res.data && res.data.success) {
//         setInfo(`Matches saved: ${res.data.data?.filename ?? ""}`);
//         // optional: reset UI after save
//         // setResult(null); setSelectedFile(null); setSelections({});
//       } else {
//         setError(res.data?.message || "Failed to save matches");
//       }
//     } catch (err) {
//       console.error(err);
//       setError(err.response?.data?.message || err.message || "Save failed");
//     } finally {
//       setSaving(false);
//     }
//   };

//   const clearFile = () => {
//     setSelectedFile(null);
//     setError("");
//     setInfo("");
//     setResult(null);
//     setSelections({});
//     if (fileInputRef.current) fileInputRef.current.value = "";
//   };

//   return (
//     <div className="min-h-screen bg-gradient-to-b from-white to-slate-50 flex flex-col">
//       <header className="max-w-6xl mx-auto w-full p-6 flex items-center justify-between">
//         <div className="flex items-center gap-3">
//           <div className="w-10 h-10 rounded-lg bg-indigo-600 flex items-center justify-center text-white font-bold">RD</div>
//           <div>
//             <h1 className="text-lg font-semibold">Readily Audit</h1>
//             <p className="text-xs text-slate-500">Audit question matcher for policy evidence</p>
//           </div>
//         </div>
//       </header>

//       <main className="flex w-full">
//         <section className="mx-auto px-6 py-12 grid gap-10 items-center w-full max-w-4xl">
//           <div className="bg-white rounded-xl shadow p-6">
//             <div className="text-slate-500 text-sm">Upload your audit questions</div>

//             <div
//               id="upload"
//               className={`mt-4 border-2 border-dashed p-6 rounded-md text-center transition-colors ${isDragOver ? "border-indigo-400 bg-indigo-50" : "border-slate-200"}`}
//               onDragOver={handleDragOver}
//               onDragLeave={handleDragLeave}
//               onDrop={handleDrop}
//             >
//               {selectedFile ? (
//                 <div className="text-left">
//                   <div className="flex items-center justify-between">
//                     <div>
//                       <div className="text-green-700 font-medium">✓ {selectedFile.name}</div>
//                       <div className="text-xs text-green-600 mt-1">File ready ({(selectedFile.size / 1024 / 1024).toFixed(2)} MB)</div>
//                     </div>

//                     <div className="flex gap-2">
//                       <button onClick={clearFile} className="px-3 py-1 bg-gray-100 rounded-md text-sm hover:bg-gray-200">Remove</button>
//                       <button onClick={uploadFile} disabled={uploading} className="px-4 py-2 bg-indigo-600 text-white rounded-md hover:bg-indigo-700 disabled:opacity-60">
//                         {uploading ? "Processing..." : "Upload & Search Drive"}
//                       </button>
//                     </div>
//                   </div>
//                 </div>
//               ) : (
//                 <>
//                   <div className="text-slate-700 font-medium">Drag & drop your PDF here</div>
//                   <div className="text-xs text-slate-400 mt-2">We’ll extract questions and search policy documents in the configured Drive folder.</div>

//                   <div className="mt-4 flex items-center justify-center gap-3">
//                     <button onClick={handleFileClick} className="px-4 py-2 bg-indigo-600 text-white rounded-md hover:bg-indigo-700 transition-colors">Choose file</button>
//                     <div className="text-xs text-slate-500">or drop a file into this box</div>
//                   </div>
//                 </>
//               )}

//               <input type="file" accept="application/pdf" ref={fileInputRef} onChange={handleFileChange} className="hidden" />
//             </div>

//             <div className="mt-3 min-h-[1.2rem]">
//               {error ? (
//                 <div className="text-sm text-red-600">{error}</div>
//               ) : info ? (
//                 <div className="text-sm text-green-600">{info}</div>
//               ) : selectedFile ? (
//                 <div className="text-sm text-slate-600">File validated — ready to upload.</div>
//               ) : (
//                 <div className="text-sm text-slate-500">Accepted format: PDF. Max size: 10 MB.</div>
//               )}
//             </div>

//             <div className="mt-4 text-xs text-slate-500">
//               <strong>Note:</strong> Make sure the Drive folder is shared with the app's service account email for backend access.
//             </div>
//           </div>

//           {/* Results & Matching */}
//           {result && (
//             <div className="bg-white rounded-xl shadow p-6">
//               <div className="flex items-center justify-between mb-3">
//                 <div>
//                   <h2 className="text-lg font-semibold">Review Matches</h2>
//                   <div className="text-xs text-slate-500">Select the best matching excerpt for each question (or choose No match).</div>
//                 </div>
//                 <div className="text-sm text-slate-600">
//                   Docs searched: <strong>{result.meta?.driveDocsCount ?? 0}</strong>
//                 </div>
//               </div>

//               {(result.questions || []).map((q) => {
//                 const candidates = result.candidatesByQuestion?.[q.id] ?? result.candidatesByQuestion?.[String(q.id)] ?? [];
//                 return (
//                   <div key={q.id} className="border-t pt-4 mt-4">
//                     <div className="mb-2"><strong>{q.id}.</strong> {q.text}</div>

//                     <div className="space-y-2">
//                       {candidates.length === 0 && <div className="text-xs text-slate-500">No candidate evidence found.</div>}

//                       {candidates.map((c, idx) => (
//                         <label key={idx} className="block bg-slate-50 p-3 rounded-md cursor-pointer">
//                           <input
//                             type="radio"
//                             name={`q-${q.id}`}
//                             checked={selections[q.id] === idx}
//                             onChange={() => choose(q.id, idx)}
//                             className="mr-2"
//                           />
//                           <span className="text-sm font-medium">{c.docName} — score: {c.score?.toFixed(2)}</span>
//                           <div className="text-xs mt-1 text-slate-700">{c.excerpt}</div>
//                         </label>
//                       ))}

//                       <label className="block">
//                         <input
//                           type="radio"
//                           name={`q-${q.id}`}
//                           checked={selections[q.id] === "nomatch"}
//                           onChange={() => choose(q.id, "nomatch")}
//                           className="mr-2"
//                         />
//                         <span className="text-sm text-slate-600">No match / Not found</span>
//                       </label>
//                     </div>
//                   </div>
//                 );
//               })}

//               <div className="mt-6 flex gap-3">
//                 <button onClick={submitMatches} disabled={saving} className="px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 disabled:opacity-60">
//                   {saving ? "Saving..." : "Submit Matches"}
//                 </button>
//                 <button onClick={() => { setResult(null); setSelections({}); }} className="px-4 py-2 bg-gray-100 rounded-md hover:bg-gray-200">
//                   Start Over
//                 </button>
//               </div>

//               {error && <div className="mt-3 text-sm text-red-600">{error}</div>}
//               {info && <div className="mt-3 text-sm text-green-600">{info}</div>}
//             </div>
//           )}
//         </section>
//       </main>
//     </div>
//   );
// }

// export default App;
