// pdfkit-text.swift <pdf> — print a PDF's text the way macOS PDFKit extracts it, i.e. what
// Preview's select-all + copy yields (drawing order, no blank lines between paragraphs).
// Run: swift pdfkit-text.swift file.pdf
import PDFKit

guard CommandLine.arguments.count == 2,
      let doc = PDFDocument(url: URL(fileURLWithPath: CommandLine.arguments[1])) else {
    FileHandle.standardError.write("usage: swift pdfkit-text.swift <pdf>\n".data(using: .utf8)!)
    exit(2)
}
for i in 0..<doc.pageCount { print(doc.page(at: i)?.string ?? "") }
