from __future__ import annotations

import argparse
import json
import os
import re
import tempfile
import zipfile
from copy import deepcopy
from pathlib import Path
from typing import Any

from docx import Document
from docx.document import Document as DocumentObject
from docx.enum.section import WD_SECTION
from docx.enum.table import WD_CELL_VERTICAL_ALIGNMENT, WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK, WD_LINE_SPACING
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, RGBColor
from lxml import etree


BODY_FONT = "仿宋_GB2312"
HEADING_FONT = "黑体"
TITLE_FONT = "方正小标宋简体"
NUMBER_FONT = "Times New Roman"
WORD_NAMESPACE = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
RELATIONSHIP_NAMESPACE = "http://schemas.openxmlformats.org/package/2006/relationships"
CONTENT_TYPES_NAMESPACE = "http://schemas.openxmlformats.org/package/2006/content-types"


def set_run_font(run: Any, chinese: str, size: float, bold: bool = False) -> None:
    run.font.name = NUMBER_FONT
    run.font.size = Pt(size)
    run.font.bold = bold
    run._element.rPr.rFonts.set(qn("w:eastAsia"), chinese)


def set_cell_shading(cell: Any, fill: str) -> None:
    tc_pr = cell._tc.get_or_add_tcPr()
    shading = OxmlElement("w:shd")
    shading.set(qn("w:fill"), fill)
    tc_pr.append(shading)


def set_cell_margins(cell: Any, top: int = 70, start: int = 80, bottom: int = 70, end: int = 80) -> None:
    tc = cell._tc
    tc_pr = tc.get_or_add_tcPr()
    tc_mar = tc_pr.first_child_found_in("w:tcMar")
    if tc_mar is None:
        tc_mar = OxmlElement("w:tcMar")
        tc_pr.append(tc_mar)
    for key, value in (("top", top), ("start", start), ("bottom", bottom), ("end", end)):
        node = tc_mar.find(qn(f"w:{key}"))
        if node is None:
            node = OxmlElement(f"w:{key}")
            tc_mar.append(node)
        node.set(qn("w:w"), str(value))
        node.set(qn("w:type"), "dxa")


def set_table_borders(table: Any) -> None:
    tbl_pr = table._tbl.tblPr
    borders = tbl_pr.first_child_found_in("w:tblBorders")
    if borders is None:
        borders = OxmlElement("w:tblBorders")
        tbl_pr.append(borders)
    for edge in ("top", "left", "bottom", "right", "insideH", "insideV"):
        node = OxmlElement(f"w:{edge}")
        node.set(qn("w:val"), "single")
        node.set(qn("w:sz"), "4")
        node.set(qn("w:space"), "0")
        node.set(qn("w:color"), "000000")
        borders.append(node)


def remove_document_body(document: DocumentObject) -> None:
    body = document._element.body
    for child in list(body):
        if child.tag != qn("w:sectPr"):
            body.remove(child)


def paragraph_format(paragraph: Any, *, indent: bool = True, space_before: float = 0, space_after: float = 0) -> None:
    fmt = paragraph.paragraph_format
    fmt.line_spacing_rule = WD_LINE_SPACING.ONE_POINT_FIVE
    fmt.space_before = Pt(space_before)
    fmt.space_after = Pt(space_after)
    fmt.first_line_indent = Cm(0.74) if indent else None
    fmt.keep_together = False
    fmt.widow_control = True


def first_run_with_text(paragraph: Any) -> Any | None:
    return next((run for run in paragraph.runs if run.text.strip()), None)


def copy_paragraph_format(target: Any, source: Any, text: str) -> None:
    try:
        target.style = source.style
    except (KeyError, ValueError):
        pass
    source_p_pr = source._p.pPr
    if source_p_pr is not None:
        target_p_pr = target._p.pPr
        if target_p_pr is not None:
            target._p.remove(target_p_pr)
        target._p.insert(0, deepcopy(source_p_pr))
    run = target.add_run(text)
    source_run = first_run_with_text(source)
    if source_run is not None and source_run._r.rPr is not None:
        run._r.insert(0, deepcopy(source_run._r.rPr))


def add_text_paragraph(
    document: DocumentObject,
    text: str,
    *,
    font: str = BODY_FONT,
    size: float = 16,
    bold: bool = False,
    align: WD_ALIGN_PARAGRAPH = WD_ALIGN_PARAGRAPH.JUSTIFY,
    indent: bool = True,
    keep_with_next: bool = False,
    space_before: float = 0,
    space_after: float = 0,
    prototype: Any | None = None,
) -> Any:
    paragraph = document.add_paragraph()
    if prototype is not None:
        copy_paragraph_format(paragraph, prototype, text)
        return paragraph
    paragraph.alignment = align
    paragraph_format(
        paragraph,
        indent=indent,
        space_before=space_before,
        space_after=space_after,
    )
    paragraph.paragraph_format.keep_with_next = keep_with_next
    run = paragraph.add_run(text)
    set_run_font(run, font, size, bold)
    return paragraph


def copy_table_cell_format(target: Any, source: Any) -> None:
    source_tc_pr = source._tc.tcPr
    if source_tc_pr is not None:
        target_tc_pr = target._tc.tcPr
        if target_tc_pr is not None:
            target._tc.remove(target_tc_pr)
        target._tc.insert(0, deepcopy(source_tc_pr))
    source_paragraph = source.paragraphs[0]
    target_paragraph = target.paragraphs[0]
    source_p_pr = source_paragraph._p.pPr
    if source_p_pr is not None:
        target_p_pr = target_paragraph._p.pPr
        if target_p_pr is not None:
            target_paragraph._p.remove(target_p_pr)
        target_paragraph._p.insert(0, deepcopy(source_p_pr))


def set_cell_text_from_prototype(cell: Any, source: Any, value: Any) -> None:
    cell.text = ""
    copy_table_cell_format(cell, source)
    paragraph = cell.paragraphs[0]
    run = paragraph.add_run(str(value))
    source_run = first_run_with_text(source.paragraphs[0])
    if source_run is not None and source_run._r.rPr is not None:
        run._r.insert(0, deepcopy(source_run._r.rPr))
    if isinstance(value, (int, float)) and value < 0:
        run.font.color.rgb = RGBColor(255, 0, 0)


def add_table(
    document: DocumentObject,
    table_data: dict[str, Any],
    title_prototype: Any | None,
    table_prototype: Any | None,
    note_prototype: Any | None,
) -> None:
    title_line = table_data["title"]
    if table_data.get("unit"):
        title_line = f"{title_line}\t单位：{table_data['unit']}"
    add_text_paragraph(
        document,
        title_line,
        font=HEADING_FONT,
        size=11,
        bold=True,
        indent=False,
        keep_with_next=True,
        space_before=2,
        prototype=title_prototype,
    )
    headers = table_data["headers"]
    rows = table_data["rows"]
    table = document.add_table(rows=1, cols=len(headers))
    target_widths: list[int] | None = None
    if table_prototype is not None and table_prototype._tbl.tblPr is not None:
        target_tbl_pr = table._tbl.tblPr
        if target_tbl_pr is not None:
            table._tbl.remove(target_tbl_pr)
        table._tbl.insert(0, deepcopy(table_prototype._tbl.tblPr))
        source_grid = table_prototype._tbl.tblGrid
        target_grid = table._tbl.tblGrid
        if target_grid is not None:
            table._tbl.remove(target_grid)
        if source_grid is not None:
            source_widths = [
                int(grid_col.get(qn("w:w"), "0"))
                for grid_col in source_grid.findall(qn("w:gridCol"))
            ]
            total_width = sum(source_widths) or 8728
            first_width = source_widths[0] if source_widths else int(total_width * 0.34)
            other_width = int((total_width - first_width) / max(len(headers) - 1, 1))
            target_widths = [first_width] + [other_width] * max(len(headers) - 1, 0)
            rebuilt_grid = OxmlElement("w:tblGrid")
            for width in target_widths:
                grid_col = OxmlElement("w:gridCol")
                grid_col.set(qn("w:w"), str(width))
                rebuilt_grid.append(grid_col)
            table._tbl.insert(1, rebuilt_grid)
    else:
        set_table_borders(table)
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    table.autofit = False
    for index, header in enumerate(headers):
        cell = table.rows[0].cells[index]
        if table_prototype is not None:
            source_cell = table_prototype.rows[0].cells[min(index, len(table_prototype.columns) - 1)]
            set_cell_text_from_prototype(cell, source_cell, header)
        else:
            cell.text = ""
            cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
            set_cell_shading(cell, "E7E6E6")
            set_cell_margins(cell)
            p = cell.paragraphs[0]
            p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            p.paragraph_format.space_after = Pt(0)
            p.paragraph_format.line_spacing = 1
            run = p.add_run(str(header))
            set_run_font(run, HEADING_FONT, 9, True)
    table.rows[0]._tr.get_or_add_trPr().append(OxmlElement("w:tblHeader"))
    for row_values in rows:
        row = table.add_row()
        for index, value in enumerate(row_values):
            cell = row.cells[index]
            if table_prototype is not None:
                source_row = table_prototype.rows[min(1, len(table_prototype.rows) - 1)]
                source_cell = source_row.cells[min(index, len(table_prototype.columns) - 1)]
                set_cell_text_from_prototype(cell, source_cell, value)
            else:
                cell.text = ""
                cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
                set_cell_margins(cell)
                p = cell.paragraphs[0]
                p.alignment = WD_ALIGN_PARAGRAPH.LEFT if index == 0 else WD_ALIGN_PARAGRAPH.CENTER
                p.paragraph_format.space_after = Pt(0)
                p.paragraph_format.line_spacing = 1
                run = p.add_run(str(value))
                set_run_font(run, BODY_FONT if index == 0 else NUMBER_FONT, 9)
                if isinstance(value, (int, float)) and value < 0:
                    run.font.color.rgb = RGBColor(255, 0, 0)
    if target_widths is not None:
        for row in table.rows:
            for index, cell in enumerate(row.cells):
                tc_pr = cell._tc.get_or_add_tcPr()
                tc_w = tc_pr.first_child_found_in("w:tcW")
                if tc_w is None:
                    tc_w = OxmlElement("w:tcW")
                    tc_pr.append(tc_w)
                tc_w.set(qn("w:w"), str(target_widths[index]))
                tc_w.set(qn("w:type"), "dxa")
    if table_prototype is None:
        available_width = Cm(15.4)
        first_width = Cm(5.3)
        other_width = (available_width - first_width) / max(len(headers) - 1, 1)
        for row in table.rows:
            for index, cell in enumerate(row.cells):
                cell.width = first_width if index == 0 else other_width
    for note in table_data.get("notes", []):
        add_text_paragraph(
            document,
            note,
            font=BODY_FONT,
            size=10.5,
            indent=False,
            prototype=note_prototype,
        )


def paragraph_prototypes(document: DocumentObject) -> dict[str, Any]:
    all_paragraphs = list(document.paragraphs)
    paragraphs = [paragraph for paragraph in all_paragraphs if paragraph.text.strip()]
    find = lambda pattern: next(
        (paragraph for paragraph in paragraphs if re.search(pattern, paragraph.text.strip())),
        None,
    )
    titles = paragraphs[:2]
    return {
        "leading-blank": all_paragraphs[0] if all_paragraphs and not all_paragraphs[0].text.strip() else None,
        "title-spacer": next(
            (
                all_paragraphs[index + 1]
                for index, paragraph in enumerate(all_paragraphs[:-1])
                if paragraph is titles[-1] and not all_paragraphs[index + 1].text.strip()
            ),
            None,
        ),
        "title-1": titles[0],
        "title-2": titles[1] if len(titles) > 1 else titles[0],
        "addressee": find(r"证券营业部：$"),
        "body": find(r"^(?:按照审计工作安排|根据财富管理委员会委托)"),
        "section": find(r"^[一二三四五六七八九十]+、"),
        "subsection": find(r"^（[一二三四五六七八九十]+）"),
        "finding-title": find(r"^\d+[.．、]"),
        "note": find(r"^备注："),
        "table-title-1": find(r"^表1"),
        "table-title-2": find(r"^表2"),
        "table-title-3": find(r"^表3"),
        "closing": find(r"^东方证券股份有限公司$"),
        "date": find(r"^\d{4}年.+日$"),
    }


def add_draft(
    document: DocumentObject,
    draft: dict[str, Any],
    prototypes: dict[str, Any],
    table_prototypes: list[Any],
) -> None:
    add_text_paragraph(
        document,
        "",
        size=16,
        indent=False,
        prototype=prototypes["leading-blank"],
    )
    for index, title in enumerate(draft["titleLines"]):
        add_text_paragraph(
            document,
            title,
            font=TITLE_FONT,
            size=22,
            bold=False,
            align=WD_ALIGN_PARAGRAPH.CENTER,
            indent=False,
            keep_with_next=True,
            space_before=10 if index == 0 else 0,
            space_after=2,
            prototype=prototypes[f"title-{min(index + 1, 2)}"],
        )
    add_text_paragraph(
        document,
        "",
        size=16,
        indent=False,
        prototype=prototypes["title-spacer"],
    )
    if draft.get("addressee"):
        add_text_paragraph(
            document,
            draft["addressee"],
            size=16,
            indent=False,
            align=WD_ALIGN_PARAGRAPH.LEFT,
            keep_with_next=True,
            prototype=prototypes["addressee"],
        )
    add_text_paragraph(
        document,
        draft["introduction"]["text"],
        size=16,
        prototype=prototypes["body"],
    )
    for section in draft["sections"]:
        add_text_paragraph(
            document,
            section["heading"],
            font=HEADING_FONT,
            size=16,
            bold=False,
            indent=False,
            align=WD_ALIGN_PARAGRAPH.LEFT,
            keep_with_next=True,
            space_before=2,
            prototype=prototypes["section"],
        )
        for item in section["paragraphs"]:
            is_finding_title = item["paragraphId"].endswith("-title")
            is_note = item["text"].startswith("备注：")
            add_text_paragraph(
                document,
                item["text"],
                font=BODY_FONT,
                size=10.5 if is_note else 16,
                bold=is_finding_title,
                indent=not is_finding_title and not is_note,
                keep_with_next=is_finding_title,
                prototype=(
                    prototypes["finding-title"]
                    if is_finding_title
                    else prototypes["note"]
                    if is_note
                    else prototypes["body"]
                ),
            )
        for table_index, table_data in enumerate(section["tables"]):
            add_table(
                document,
                table_data,
                prototypes[f"table-title-{min(table_index + 1, 3)}"],
                table_prototypes[min(table_index, len(table_prototypes) - 1)]
                if table_prototypes
                else None,
                prototypes["note"],
            )
        for subsection in section["subsections"]:
            add_text_paragraph(
                document,
                subsection["heading"],
                font="楷体_GB2312",
                size=16,
                bold=True,
                indent=True,
                align=WD_ALIGN_PARAGRAPH.LEFT,
                keep_with_next=True,
                space_before=8,
                prototype=prototypes["subsection"],
            )
            table_index = subsection.get(
                "tablesAfterParagraphCount", len(subsection["paragraphs"])
            )
            for index, item in enumerate(subsection["paragraphs"]):
                if index == table_index:
                    for nested_table_index, table_data in enumerate(subsection.get("tables", [])):
                        add_table(
                            document,
                            table_data,
                            prototypes[f"table-title-{min(nested_table_index + 1, 3)}"],
                            table_prototypes[min(nested_table_index, len(table_prototypes) - 1)]
                            if table_prototypes
                            else None,
                            prototypes["note"],
                        )
                is_finding_title = item["paragraphId"].endswith("-title")
                is_note = item["text"].startswith("备注：")
                add_text_paragraph(
                    document,
                    item["text"],
                    font=BODY_FONT,
                    size=10.5 if is_note else 16,
                    bold=is_finding_title,
                    indent=not is_finding_title and not is_note,
                    keep_with_next=is_finding_title,
                    prototype=(
                        prototypes["finding-title"]
                        if is_finding_title
                        else prototypes["note"]
                        if is_note
                        else prototypes["body"]
                    ),
                )
            if table_index >= len(subsection["paragraphs"]):
                for nested_table_index, table_data in enumerate(subsection.get("tables", [])):
                    add_table(
                        document,
                        table_data,
                        prototypes[f"table-title-{min(nested_table_index + 1, 3)}"],
                        table_prototypes[min(nested_table_index, len(table_prototypes) - 1)]
                        if table_prototypes
                        else None,
                        prototypes["note"],
                    )
        for item in section.get("closingParagraphs", []):
            add_text_paragraph(
                document,
                item["text"],
                font=BODY_FONT,
                size=16,
                prototype=prototypes["body"],
            )
    add_text_paragraph(
        document,
        draft["closingOrganization"],
        size=16,
        indent=False,
        align=WD_ALIGN_PARAGRAPH.RIGHT,
        space_before=4,
        prototype=prototypes["closing"],
    )
    add_text_paragraph(
        document,
        draft["reportDate"],
        size=16,
        indent=False,
        align=WD_ALIGN_PARAGRAPH.RIGHT,
        prototype=prototypes["date"],
    )
    if draft["status"] == "needs-input":
        warning = add_text_paragraph(
            document,
            "【数据未就绪：本草稿不得作为正式审计报告】",
            font=HEADING_FONT,
            size=12,
            bold=True,
            align=WD_ALIGN_PARAGRAPH.CENTER,
            indent=False,
        )
        for run in warning.runs:
            run.font.color.rgb = RGBColor(255, 0, 0)


def configure_document(document: DocumentObject) -> None:
    styles = document.styles
    normal = styles["Normal"]
    normal.font.name = NUMBER_FONT
    normal.font.size = Pt(16)
    normal._element.rPr.rFonts.set(qn("w:eastAsia"), BODY_FONT)
    for section in document.sections:
        section.start_type = WD_SECTION.CONTINUOUS
        section.different_first_page_header_footer = False


def sanitize_review_markup(path: Path) -> None:
    review_parts = {
        "word/comments.xml",
        "word/commentsExtended.xml",
        "word/commentsExtensible.xml",
        "word/commentsIds.xml",
        "word/people.xml",
    }
    removable_tags = {
        f"{{{WORD_NAMESPACE}}}commentRangeStart",
        f"{{{WORD_NAMESPACE}}}commentRangeEnd",
        f"{{{WORD_NAMESPACE}}}commentReference",
        f"{{{WORD_NAMESPACE}}}del",
        f"{{{WORD_NAMESPACE}}}moveFrom",
        f"{{{WORD_NAMESPACE}}}pPrChange",
        f"{{{WORD_NAMESPACE}}}rPrChange",
        f"{{{WORD_NAMESPACE}}}tblPrChange",
        f"{{{WORD_NAMESPACE}}}tblGridChange",
        f"{{{WORD_NAMESPACE}}}trPrChange",
        f"{{{WORD_NAMESPACE}}}tcPrChange",
        f"{{{WORD_NAMESPACE}}}sectPrChange",
        f"{{{WORD_NAMESPACE}}}numPrChange",
    }
    accepted_tags = {
        f"{{{WORD_NAMESPACE}}}ins",
        f"{{{WORD_NAMESPACE}}}moveTo",
    }
    with tempfile.NamedTemporaryFile(
        suffix=".docx", dir=path.parent, delete=False
    ) as temporary:
        temporary_path = Path(temporary.name)
    try:
        with zipfile.ZipFile(path, "r") as source, zipfile.ZipFile(
            temporary_path, "w", zipfile.ZIP_DEFLATED
        ) as target:
            for info in source.infolist():
                if info.filename in review_parts:
                    continue
                payload = source.read(info.filename)
                if info.filename.endswith(".xml"):
                    root = etree.fromstring(payload)
                    changed = False
                    for element in list(root.iter()):
                        parent = element.getparent()
                        if parent is None:
                            continue
                        if element.tag in removable_tags:
                            parent.remove(element)
                            changed = True
                        elif element.tag in accepted_tags:
                            index = parent.index(element)
                            for child in list(element):
                                parent.insert(index, child)
                                index += 1
                            parent.remove(element)
                            changed = True
                    if changed:
                        payload = etree.tostring(
                            root, xml_declaration=True, encoding="UTF-8", standalone=True
                        )
                elif info.filename.endswith(".rels"):
                    root = etree.fromstring(payload)
                    changed = False
                    for relationship in list(root):
                        target_name = relationship.get("Target", "")
                        relationship_type = relationship.get("Type", "")
                        if any(token in target_name or token in relationship_type for token in ("comments", "people")):
                            root.remove(relationship)
                            changed = True
                    if changed:
                        payload = etree.tostring(
                            root, xml_declaration=True, encoding="UTF-8", standalone=True
                        )
                if info.filename == "[Content_Types].xml":
                    root = etree.fromstring(payload)
                    changed = False
                    for override in list(root):
                        if any(token in override.get("PartName", "") for token in ("comments", "people")):
                            root.remove(override)
                            changed = True
                    if changed:
                        payload = etree.tostring(
                            root, xml_declaration=True, encoding="UTF-8", standalone=True
                        )
                target.writestr(info, payload)
        os.replace(temporary_path, path)
    finally:
        temporary_path.unlink(missing_ok=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--template", required=True, type=Path)
    parser.add_argument("--draft", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    draft = json.loads(args.draft.read_text(encoding="utf-8"))
    document = Document(str(args.template))
    prototypes = paragraph_prototypes(document)
    table_prototypes = list(document.tables)
    remove_document_body(document)
    add_draft(document, draft, prototypes, table_prototypes)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    document.save(str(args.output))
    sanitize_review_markup(args.output)


if __name__ == "__main__":
    main()
