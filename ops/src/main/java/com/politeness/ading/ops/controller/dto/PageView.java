package com.politeness.ading.ops.controller.dto;

import java.util.List;

public record PageView<T>(int page, int size, long total, List<T> items) {
}
