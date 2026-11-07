use std::collections::VecDeque;

/// The last lines of a server's console, bounded in count and in the length of each line, so a chatty or
/// misbehaving server can never grow the app's memory without limit.
#[derive(Debug)]
pub struct LogBuffer {
    lines: VecDeque<String>,
    max_lines: usize,
    max_line_bytes: usize,
    dropped: u64,
}

const TRUNCATED: &str = " …[line cut]";

impl LogBuffer {
    pub fn new(max_lines: usize, max_line_bytes: usize) -> Self {
        Self { lines: VecDeque::with_capacity(max_lines.min(1024)), max_lines: max_lines.max(1), max_line_bytes: max_line_bytes.max(16), dropped: 0 }
    }

    pub fn push(&mut self, line: &str) {
        if self.lines.len() == self.max_lines {
            self.lines.pop_front();
            self.dropped += 1;
        }
        self.lines.push_back(cut(line, self.max_line_bytes));
    }

    pub fn snapshot(&self) -> Vec<String> {
        self.lines.iter().cloned().collect()
    }

    pub fn len(&self) -> usize {
        self.lines.len()
    }

    pub fn is_empty(&self) -> bool {
        self.lines.is_empty()
    }

    /// Lines that were pushed out to make room (so the screen can say the top of the log is gone).
    pub fn dropped(&self) -> u64 {
        self.dropped
    }
}

/// `line` cut to at most `max` bytes without splitting a character.
pub fn cut(line: &str, max: usize) -> String {
    if line.len() <= max {
        return line.to_string();
    }
    let mut end = max.saturating_sub(TRUNCATED.len()).max(1);
    while !line.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}{}", &line[..end], TRUNCATED)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_only_the_newest_lines_and_counts_what_it_dropped() {
        let mut b = LogBuffer::new(3, 100);
        for i in 0..10 {
            b.push(&format!("line {i}"));
        }
        assert_eq!(b.snapshot(), vec!["line 7", "line 8", "line 9"]);
        assert_eq!(b.dropped(), 7);
    }

    #[test]
    fn cuts_long_lines_on_a_character_boundary() {
        let long = "é".repeat(500);
        let cut = cut(&long, 64);
        assert!(cut.len() <= 64);
        assert!(cut.ends_with("[line cut]"));
        assert!(std::str::from_utf8(cut.as_bytes()).is_ok());
    }

    #[test]
    fn short_lines_pass_through_unchanged() {
        let mut b = LogBuffer::new(5, 100);
        b.push("hello");
        assert_eq!(b.snapshot(), vec!["hello"]);
        assert!(!b.is_empty());
    }
}
