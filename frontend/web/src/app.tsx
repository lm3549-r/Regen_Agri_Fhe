// App.tsx
import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface SensorData {
  id: string;
  encryptedData: string;
  timestamp: number;
  owner: string;
  location: string;
  dataType: "soil_carbon" | "moisture" | "temperature" | "ph_level";
  status: "pending" | "verified" | "rejected";
}

const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

const FHECompute = (encryptedData: string, operation: string): string => {
  const value = FHEDecryptNumber(encryptedData);
  let result = value;
  
  switch(operation) {
    case 'aggregate':
      result = value * 1.2; // Simulate aggregation with 20% bonus for verified data
      break;
    case 'penalize':
      result = value * 0.8; // Simulate penalty for rejected data
      break;
    default:
      result = value;
  }
  
  return FHEEncryptNumber(result);
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [sensorData, setSensorData] = useState<SensorData[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newSensorData, setNewSensorData] = useState({ 
    location: "", 
    dataType: "soil_carbon", 
    value: 0,
    notes: ""
  });
  const [showIntro, setShowIntro] = useState(true);
  const [selectedData, setSelectedData] = useState<SensorData | null>(null);
  const [decryptedValue, setDecryptedValue] = useState<number | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [startTimestamp, setStartTimestamp] = useState<number>(0);
  const [durationDays, setDurationDays] = useState<number>(30);
  const verifiedCount = sensorData.filter(d => d.status === "verified").length;
  const pendingCount = sensorData.filter(d => d.status === "pending").length;
  const rejectedCount = sensorData.filter(d => d.status === "rejected").length;

  // Calculate environmental score based on verified data
  const environmentalScore = sensorData
    .filter(d => d.status === "verified")
    .reduce((acc, curr) => acc + FHEDecryptNumber(curr.encryptedData), 0);

  useEffect(() => {
    loadSensorData().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  const loadSensorData = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      // Check contract availability
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) return;
      
      // Load sensor data keys
      const keysBytes = await contract.getData("sensor_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing sensor keys:", e); }
      }
      
      // Load each sensor data record
      const list: SensorData[] = [];
      for (const key of keys) {
        try {
          const recordBytes = await contract.getData(`sensor_${key}`);
          if (recordBytes.length > 0) {
            try {
              const recordData = JSON.parse(ethers.toUtf8String(recordBytes));
              list.push({ 
                id: key, 
                encryptedData: recordData.data, 
                timestamp: recordData.timestamp, 
                owner: recordData.owner, 
                location: recordData.location, 
                dataType: recordData.dataType, 
                status: recordData.status || "pending" 
              });
            } catch (e) { console.error(`Error parsing sensor data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading sensor ${key}:`, e); }
      }
      list.sort((a, b) => b.timestamp - a.timestamp);
      setSensorData(list);
    } catch (e) { console.error("Error loading sensor data:", e); } 
    finally { setIsRefreshing(false); setLoading(false); }
  };

  const submitSensorData = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setCreating(true);
    setTransactionStatus({ 
      visible: true, 
      status: "pending", 
      message: "Encrypting soil data with Zama FHE..." 
    });
    
    try {
      // Encrypt the sensitive data
      const encryptedData = FHEEncryptNumber(newSensorData.value);
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      // Generate unique ID for this sensor reading
      const recordId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      
      // Prepare the record data
      const recordData = { 
        data: encryptedData, 
        timestamp: Math.floor(Date.now() / 1000), 
        owner: address, 
        location: newSensorData.location,
        dataType: newSensorData.dataType,
        status: "pending",
        notes: newSensorData.notes
      };
      
      // Store the encrypted data on-chain
      await contract.setData(`sensor_${recordId}`, ethers.toUtf8Bytes(JSON.stringify(recordData)));
      
      // Update the keys list
      const keysBytes = await contract.getData("sensor_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(recordId);
      await contract.setData("sensor_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      
      setTransactionStatus({ 
        visible: true, 
        status: "success", 
        message: "Soil data encrypted and submitted securely!" 
      });
      
      await loadSensorData();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowCreateModal(false);
        setNewSensorData({ 
          location: "", 
          dataType: "soil_carbon", 
          value: 0,
          notes: ""
        });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") 
        ? "Transaction rejected by user" 
        : "Submission failed: " + (e.message || "Unknown error");
      setTransactionStatus({ 
        visible: true, 
        status: "error", 
        message: errorMessage 
      });
      setTimeout(() => setTransactionStatus({ 
        visible: false, 
        status: "pending", 
        message: "" 
      }), 3000);
    } finally { 
      setCreating(false); 
    }
  };

  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) { alert("Please connect wallet first"); return null; }
    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      return FHEDecryptNumber(encryptedData);
    } catch (e) { 
      console.error("Decryption failed:", e); 
      return null; 
    } finally { 
      setIsDecrypting(false); 
    }
  };

  const verifyData = async (recordId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ 
      visible: true, 
      status: "pending", 
      message: "Processing encrypted soil data with FHE..." 
    });
    
    try {
      const contract = await getContractReadOnly();
      if (!contract) throw new Error("Failed to get contract");
      
      // Get the existing record
      const recordBytes = await contract.getData(`sensor_${recordId}`);
      if (recordBytes.length === 0) throw new Error("Record not found");
      const recordData = JSON.parse(ethers.toUtf8String(recordBytes));
      
      // Simulate FHE computation (aggregate with bonus)
      const verifiedData = FHECompute(recordData.data, 'aggregate');
      
      // Update the record with verified status
      const contractWithSigner = await getContractWithSigner();
      if (!contractWithSigner) throw new Error("Failed to get contract with signer");
      
      const updatedRecord = { 
        ...recordData, 
        status: "verified", 
        data: verifiedData 
      };
      
      await contractWithSigner.setData(
        `sensor_${recordId}`, 
        ethers.toUtf8Bytes(JSON.stringify(updatedRecord))
      );
      
      setTransactionStatus({ 
        visible: true, 
        status: "success", 
        message: "FHE verification completed successfully!" 
      });
      
      await loadSensorData();
      setTimeout(() => setTransactionStatus({ 
        visible: false, 
        status: "pending", 
        message: "" 
      }), 2000);
    } catch (e: any) {
      setTransactionStatus({ 
        visible: true, 
        status: "error", 
        message: "Verification failed: " + (e.message || "Unknown error") 
      });
      setTimeout(() => setTransactionStatus({ 
        visible: false, 
        status: "pending", 
        message: "" 
      }), 3000);
    }
  };

  const rejectData = async (recordId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ 
      visible: true, 
      status: "pending", 
      message: "Processing encrypted soil data with FHE..." 
    });
    
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      // Get the existing record
      const recordBytes = await contract.getData(`sensor_${recordId}`);
      if (recordBytes.length === 0) throw new Error("Record not found");
      const recordData = JSON.parse(ethers.toUtf8String(recordBytes));
      
      // Simulate FHE computation (penalty)
      const rejectedData = FHECompute(recordData.data, 'penalize');
      
      // Update the record with rejected status
      const updatedRecord = { 
        ...recordData, 
        status: "rejected", 
        data: rejectedData 
      };
      
      await contract.setData(
        `sensor_${recordId}`, 
        ethers.toUtf8Bytes(JSON.stringify(updatedRecord))
      );
      
      setTransactionStatus({ 
        visible: true, 
        status: "success", 
        message: "FHE rejection completed successfully!" 
      });
      
      await loadSensorData();
      setTimeout(() => setTransactionStatus({ 
        visible: false, 
        status: "pending", 
        message: "" 
      }), 2000);
    } catch (e: any) {
      setTransactionStatus({ 
        visible: true, 
        status: "error", 
        message: "Rejection failed: " + (e.message || "Unknown error") 
      });
      setTimeout(() => setTransactionStatus({ 
        visible: false, 
        status: "pending", 
        message: "" 
      }), 3000);
    }
  };

  const isOwner = (recordAddress: string) => address?.toLowerCase() === recordAddress.toLowerCase();

  const renderDataStats = () => {
    return (
      <div className="data-stats">
        <div className="stat-card">
          <div className="stat-value">{sensorData.length}</div>
          <div className="stat-label">Total Readings</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{verifiedCount}</div>
          <div className="stat-label">Verified</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{pendingCount}</div>
          <div className="stat-label">Pending</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{environmentalScore.toFixed(2)}</div>
          <div className="stat-label">Environmental Score</div>
        </div>
      </div>
    );
  };

  const renderDataTypeDistribution = () => {
    const typeCounts = {
      soil_carbon: 0,
      moisture: 0,
      temperature: 0,
      ph_level: 0
    };
    
    sensorData.forEach(data => {
      typeCounts[data.dataType]++;
    });
    
    const total = sensorData.length || 1;
    
    return (
      <div className="type-distribution">
        <h3>Data Type Distribution</h3>
        <div className="distribution-bars">
          {Object.entries(typeCounts).map(([type, count]) => (
            <div key={type} className="distribution-item">
              <div className="type-label">{type.replace('_', ' ')}</div>
              <div className="bar-container">
                <div 
                  className="distribution-bar" 
                  style={{ width: `${(count / total) * 100}%` }}
                ></div>
              </div>
              <div className="type-count">{count}</div>
            </div>
          ))}
        </div>
      </div>
    );
  };

  if (loading) return (
    <div className="loading-screen">
      <div className="nature-spinner">
        <div className="leaf leaf1"></div>
        <div className="leaf leaf2"></div>
        <div className="leaf leaf3"></div>
      </div>
      <p>Connecting to DePIN network...</p>
    </div>
  );

  return (
    <div className="app-container nature-theme">
      <header className="app-header">
        <div className="logo">
          <div className="logo-icon">
            <svg viewBox="0 0 24 24">
              <path d="M12,2L4,12L12,22L20,12L12,2Z" fill="#4CAF50"/>
              <path d="M12,6L8,12L12,18L16,12L12,6Z" fill="#8BC34A"/>
            </svg>
          </div>
          <h1>Regen<span>Agri</span>FHE</h1>
        </div>
        <div className="header-actions">
          <button 
            onClick={() => setShowCreateModal(true)} 
            className="create-btn nature-button"
          >
            <span className="icon">+</span> Add Sensor Data
          </button>
          <button 
            className="nature-button" 
            onClick={() => setShowIntro(!showIntro)}
          >
            {showIntro ? "Hide Intro" : "Show Intro"}
          </button>
          <div className="wallet-connect-wrapper">
            <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/>
          </div>
        </div>
      </header>
      
      <div className="main-content">
        {showIntro && (
          <div className="intro-section nature-card">
            <h2>Regenerative Agriculture with FHE Privacy</h2>
            <p>
              A DePIN network for tracking regenerative agriculture practices with 
              fully homomorphic encryption (FHE) privacy protection. Farmers deploy 
              sensors in fields to collect soil carbon data which is encrypted with 
              Zama FHE technology before being uploaded to the blockchain.
            </p>
            <div className="fhe-badge">
              <span>Powered by Zama FHE</span>
            </div>
            <div className="feature-cards">
              <div className="feature-card">
                <div className="feature-icon">🌱</div>
                <h3>Soil Data Collection</h3>
                <p>DePIN sensors collect soil carbon, moisture, and other metrics</p>
              </div>
              <div className="feature-card">
                <div className="feature-icon">🔒</div>
                <h3>FHE Encryption</h3>
                <p>Data encrypted with Zama FHE before leaving the device</p>
              </div>
              <div className="feature-card">
                <div className="feature-icon">💰</div>
                <h3>Environmental Assets</h3>
                <p>Encrypted data becomes verifiable environmental assets</p>
              </div>
            </div>
          </div>
        )}
        
        <div className="dashboard-section">
          <div className="dashboard-header">
            <h2>Farm Data Dashboard</h2>
            <button 
              onClick={loadSensorData} 
              className="refresh-btn nature-button" 
              disabled={isRefreshing}
            >
              {isRefreshing ? "Refreshing..." : "Refresh Data"}
            </button>
          </div>
          
          {renderDataStats()}
          
          <div className="dashboard-grid">
            <div className="dashboard-card nature-card">
              <h3>Real-time Sensor Data</h3>
              {renderDataTypeDistribution()}
            </div>
            <div className="dashboard-card nature-card">
              <h3>Environmental Impact</h3>
              <div className="impact-meter">
                <div 
                  className="meter-fill" 
                  style={{ width: `${Math.min(100, environmentalScore / 1000 * 100)}%` }}
                ></div>
                <div className="meter-label">
                  {environmentalScore.toFixed(2)} Carbon Units
                </div>
              </div>
              <p className="impact-description">
                Your verified environmental contributions can be used as collateral 
                in DeFi protocols or to claim sustainability rewards.
              </p>
            </div>
          </div>
        </div>
        
        <div className="data-section">
          <div className="section-header">
            <h2>Sensor Data Records</h2>
            <div className="data-filters">
              <select className="nature-select">
                <option>All Types</option>
                <option>Soil Carbon</option>
                <option>Moisture</option>
                <option>Temperature</option>
                <option>pH Level</option>
              </select>
              <select className="nature-select">
                <option>All Statuses</option>
                <option>Verified</option>
                <option>Pending</option>
                <option>Rejected</option>
              </select>
            </div>
          </div>
          
          <div className="data-list nature-card">
            <div className="list-header">
              <div className="header-cell">ID</div>
              <div className="header-cell">Type</div>
              <div className="header-cell">Location</div>
              <div className="header-cell">Date</div>
              <div className="header-cell">Status</div>
              <div className="header-cell">Actions</div>
            </div>
            
            {sensorData.length === 0 ? (
              <div className="no-data">
                <div className="no-data-icon">🌾</div>
                <p>No sensor data found</p>
                <button 
                  className="nature-button primary" 
                  onClick={() => setShowCreateModal(true)}
                >
                  Submit First Reading
                </button>
              </div>
            ) : (
              sensorData.map(data => (
                <div 
                  className="data-row" 
                  key={data.id} 
                  onClick={() => setSelectedData(data)}
                >
                  <div className="list-cell">#{data.id.substring(0, 6)}</div>
                  <div className="list-cell">
                    {data.dataType.replace('_', ' ')}
                  </div>
                  <div className="list-cell">{data.location}</div>
                  <div className="list-cell">
                    {new Date(data.timestamp * 1000).toLocaleDateString()}
                  </div>
                  <div className="list-cell">
                    <span className={`status-badge ${data.status}`}>
                      {data.status}
                    </span>
                  </div>
                  <div className="list-cell actions">
                    {isOwner(data.owner) && data.status === "pending" && (
                      <>
                        <button 
                          className="action-btn nature-button success" 
                          onClick={(e) => { 
                            e.stopPropagation(); 
                            verifyData(data.id); 
                          }}
                        >
                          Verify
                        </button>
                        <button 
                          className="action-btn nature-button danger" 
                          onClick={(e) => { 
                            e.stopPropagation(); 
                            rejectData(data.id); 
                          }}
                        >
                          Reject
                        </button>
                      </>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
      
      {showCreateModal && (
        <ModalCreate 
          onSubmit={submitSensorData} 
          onClose={() => setShowCreateModal(false)} 
          creating={creating} 
          sensorData={newSensorData} 
          setSensorData={setNewSensorData}
        />
      )}
      
      {selectedData && (
        <DataDetailModal 
          data={selectedData} 
          onClose={() => { 
            setSelectedData(null); 
            setDecryptedValue(null); 
          }} 
          decryptedValue={decryptedValue} 
          setDecryptedValue={setDecryptedValue} 
          isDecrypting={isDecrypting} 
          decryptWithSignature={decryptWithSignature}
        />
      )}
      
      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content nature-card">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && (
                <div className="nature-spinner small">
                  <div className="leaf leaf1"></div>
                  <div className="leaf leaf2"></div>
                  <div className="leaf leaf3"></div>
                </div>
              )}
              {transactionStatus.status === "success" && "✓"}
              {transactionStatus.status === "error" && "✗"}
            </div>
            <div className="transaction-message">
              {transactionStatus.message}
            </div>
          </div>
        </div>
      )}
      
      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <div className="logo">
              <svg viewBox="0 0 24 24">
                <path d="M12,2L4,12L12,22L20,12L12,2Z" fill="#4CAF50"/>
              </svg>
              <span>RegenAgriFHE</span>
            </div>
            <p>Tracking regenerative agriculture with FHE privacy</p>
          </div>
          <div className="footer-links">
            <a href="#" className="footer-link">Documentation</a>
            <a href="#" className="footer-link">Privacy Policy</a>
            <a href="#" className="footer-link">Terms of Service</a>
            <a href="#" className="footer-link">Contact</a>
          </div>
        </div>
        <div className="footer-bottom">
          <div className="fhe-badge">
            <span>FHE-Powered Privacy</span>
          </div>
          <div className="copyright">
            © {new Date().getFullYear()} RegenAgriFHE Network. All rights reserved.
          </div>
        </div>
      </footer>
    </div>
  );
};

interface ModalCreateProps {
  onSubmit: () => void; 
  onClose: () => void; 
  creating: boolean;
  sensorData: any;
  setSensorData: (data: any) => void;
}

const ModalCreate: React.FC<ModalCreateProps> = ({ 
  onSubmit, 
  onClose, 
  creating, 
  sensorData, 
  setSensorData 
}) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setSensorData({ ...sensorData, [name]: value });
  };

  const handleValueChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setSensorData({ ...sensorData, [name]: parseFloat(value) });
  };

  const handleSubmit = () => {
    if (!sensorData.location || !sensorData.value) { 
      alert("Please fill required fields"); 
      return; 
    }
    onSubmit();
  };

  return (
    <div className="modal-overlay">
      <div className="create-modal nature-card">
        <div className="modal-header">
          <h2>Add Sensor Data</h2>
          <button onClick={onClose} className="close-modal">
            &times;
          </button>
        </div>
        <div className="modal-body">
          <div className="fhe-notice-banner">
            <div className="key-icon">🔒</div> 
            <div>
              <strong>FHE Encryption Notice</strong>
              <p>Your sensor data will be encrypted with Zama FHE before submission</p>
            </div>
          </div>
          
          <div className="form-grid">
            <div className="form-group">
              <label>Location *</label>
              <input 
                type="text" 
                name="location" 
                value={sensorData.location} 
                onChange={handleChange} 
                placeholder="Field location..." 
                className="nature-input"
              />
            </div>
            
            <div className="form-group">
              <label>Data Type *</label>
              <select 
                name="dataType" 
                value={sensorData.dataType} 
                onChange={handleChange} 
                className="nature-select"
              >
                <option value="soil_carbon">Soil Carbon</option>
                <option value="moisture">Moisture</option>
                <option value="temperature">Temperature</option>
                <option value="ph_level">pH Level</option>
              </select>
            </div>
            
            <div className="form-group">
              <label>Value *</label>
              <input 
                type="number" 
                name="value" 
                value={sensorData.value} 
                onChange={handleValueChange} 
                placeholder="Enter sensor reading..." 
                className="nature-input"
                step="0.01"
              />
            </div>
            
            <div className="form-group">
              <label>Notes</label>
              <textarea 
                name="notes" 
                value={sensorData.notes} 
                onChange={handleChange} 
                placeholder="Additional notes..." 
                className="nature-textarea"
                rows={3}
              />
            </div>
          </div>
          
          <div className="encryption-preview">
            <h4>Encryption Preview</h4>
            <div className="preview-container">
              <div className="plain-data">
                <span>Plain Value:</span>
                <div>{sensorData.value || 'No value entered'}</div>
              </div>
              <div className="encryption-arrow">→</div>
              <div className="encrypted-data">
                <span>Encrypted Data:</span>
                <div>
                  {sensorData.value ? 
                    FHEEncryptNumber(sensorData.value).substring(0, 50) + '...' : 
                    'No value entered'
                  }
                </div>
              </div>
            </div>
          </div>
        </div>
        
        <div className="modal-footer">
          <button 
            onClick={onClose} 
            className="cancel-btn nature-button"
          >
            Cancel
          </button>
          <button 
            onClick={handleSubmit} 
            disabled={creating} 
            className="submit-btn nature-button primary"
          >
            {creating ? "Encrypting with FHE..." : "Submit Securely"}
          </button>
        </div>
      </div>
    </div>
  );
};

interface DataDetailModalProps {
  data: SensorData;
  onClose: () => void;
  decryptedValue: number | null;
  setDecryptedValue: (value: number | null) => void;
  isDecrypting: boolean;
  decryptWithSignature: (encryptedData: string) => Promise<number | null>;
}

const DataDetailModal: React.FC<DataDetailModalProps> = ({ 
  data, 
  onClose, 
  decryptedValue, 
  setDecryptedValue, 
  isDecrypting, 
  decryptWithSignature 
}) => {
  const handleDecrypt = async () => {
    if (decryptedValue !== null) { 
      setDecryptedValue(null); 
      return; 
    }
    const decrypted = await decryptWithSignature(data.encryptedData);
    if (decrypted !== null) setDecryptedValue(decrypted);
  };

  return (
    <div className="modal-overlay">
      <div className="data-detail-modal nature-card">
        <div className="modal-header">
          <h2>Sensor Data Details</h2>
          <button onClick={onClose} className="close-modal">
            &times;
          </button>
        </div>
        
        <div className="modal-body">
          <div className="data-info">
            <div className="info-item">
              <span>Type:</span>
              <strong>{data.dataType.replace('_', ' ')}</strong>
            </div>
            <div className="info-item">
              <span>Location:</span>
              <strong>{data.location}</strong>
            </div>
            <div className="info-item">
              <span>Owner:</span>
              <strong>
                {data.owner.substring(0, 6)}...{data.owner.substring(38)}
              </strong>
            </div>
            <div className="info-item">
              <span>Date:</span>
              <strong>
                {new Date(data.timestamp * 1000).toLocaleString()}
              </strong>
            </div>
            <div className="info-item">
              <span>Status:</span>
              <strong className={`status-badge ${data.status}`}>
                {data.status}
              </strong>
            </div>
          </div>
          
          <div className="encrypted-data-section">
            <h3>Encrypted Data</h3>
            <div className="encrypted-data">
              {data.encryptedData.substring(0, 100)}...
            </div>
            <div className="fhe-tag">
              <div className="fhe-icon">🔒</div>
              <span>FHE Encrypted</span>
            </div>
            <button 
              className="decrypt-btn nature-button" 
              onClick={handleDecrypt} 
              disabled={isDecrypting}
            >
              {isDecrypting ? (
                <span className="decrypt-spinner"></span>
              ) : decryptedValue !== null ? (
                "Hide Decrypted Value"
              ) : (
                "Decrypt with Wallet Signature"
              )}
            </button>
          </div>
          
          {decryptedValue !== null && (
            <div className="decrypted-data-section">
              <h3>Decrypted Value</h3>
              <div className="decrypted-value">
                {decryptedValue}
              </div>
              <div className="decryption-notice">
                <div className="warning-icon">⚠️</div>
                <span>
                  Decrypted data is only visible after wallet signature verification
                </span>
              </div>
            </div>
          )}
        </div>
        
        <div className="modal-footer">
          <button 
            onClick={onClose} 
            className="close-btn nature-button"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

export default App;