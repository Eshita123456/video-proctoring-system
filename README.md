# 🎥 Focus & Object Detection in Video Interviews (Proctoring System)

## 📌 Overview
This project implements a **video proctoring system** for online interviews.  
It detects whether a candidate is focused, flags suspicious activities (phones, books, multiple faces), and generates a **Proctoring Report** at the end.

---

## ✨ Features
- ✅ Live video feed from candidate’s webcam  
- ✅ Real-time **focus detection**:
  - Detects if candidate is not looking at the screen for >5 sec
  - Detects if no face is present for >10 sec
  - Detects multiple faces in the frame  
- ✅ Real-time **object detection**:
  - Mobile phone, laptops, books/notes, extra devices  
- ✅ Logs suspicious events with timestamps  
- ✅ Records the entire interview video & uploads to backend  
- ✅ Generates **Proctoring Report**:
  - Candidate Name  
  - Interview Duration  
  - Number of focus loss events  
  - Suspicious events detected  
  - Final Integrity Score (100 – deductions)  
- ✅ Report export in **JSON, CSV, and PDF**  
- ✅ Ready to deploy on **Heroku / Render / Vercel**

---

## 🛠️ Tech Stack
- **Frontend**: HTML, CSS, JavaScript  
- **Libraries**:
  - [TensorFlow.js](https://www.tensorflow.org/js)  
  - [BlazeFace](https://github.com/tensorflow/tfjs-models/tree/master/blazeface) (face detection)  
  - [COCO-SSD](https://github.com/tensorflow/tfjs-models/tree/master/coco-ssd) (object detection)  
  - [jsPDF](https://github.com/parallax/jsPDF) (report PDF export)  
- **Backend**: Node.js, Express.js  
- **Database (optional)**: MongoDB (for event logs & reports)  

---

## ⚙️ Installation & Setup
npm install
npm start


### 1️⃣ Clone the repository
```bash
cd video-proctoring


Now open:
👉 http://localhost:4000