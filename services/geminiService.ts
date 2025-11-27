import { GoogleGenAI } from "@google/genai";
import { CalculationResult } from "../types";

const getClient = () => {
  const apiKey = process.env.API_KEY;
  if (!apiKey) return null;
  return new GoogleGenAI({ apiKey });
};

export const generateAnalysis = async (data: CalculationResult, mrp: number): Promise<string> => {
  const ai = getClient();
  if (!ai) {
    return "API Key is missing. Please provide an API key to generate an analysis.";
  }

  const prompt = `
    As a pharmaceutical financial analyst, analyze this GST calculation for a product with Original MRP: ₹${mrp}.
    
    12% GST Rule Scenario:
    - New MRP: ₹${data.row12.newMrp.toFixed(2)}
    - Trade Price: ₹${data.row12.finalTradePrice.toFixed(2)} (Calculated as [New MRP * 100/105] - 20%)
    - GST/CGST Liability: ₹${data.row12.gstAmount.toFixed(2)}

    18% GST Rule Scenario:
    - New MRP: ₹${data.row18.newMrp.toFixed(2)}
    - Trade Price: ₹${data.row18.finalTradePrice.toFixed(2)} (Calculated as [New MRP * 100/105] - 20%)
    - GST/CGST Liability: ₹${data.row18.gstAmount.toFixed(2)}

    Provide a short, professional summary for the pharmacy owner comparing the Net Trade Price margins. Which scenario yields better retained earnings? Keep it under 80 words.
  `;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
    });
    return response.text || "Could not generate analysis.";
  } catch (error) {
    console.error("Gemini API Error:", error);
    return "An error occurred while communicating with the AI service.";
  }
};