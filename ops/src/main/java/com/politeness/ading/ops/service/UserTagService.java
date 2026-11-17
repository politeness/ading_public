package com.politeness.ading.ops.service;

import com.politeness.ading.ops.common.BizException;
import com.politeness.ading.ops.common.OpsError;
import com.politeness.ading.ops.dal.mapper.UserTagMapper;
import java.util.List;
import java.util.Set;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Slf4j
@Service
public class UserTagService {
    private static final Set<String> KNOWN_TAGS = Set.of("PRE_GRAY", "MAINLAND_ADD_FRIEND");
    private final UserTagMapper tags;

    public UserTagService(UserTagMapper tags) { this.tags = tags; }

    @Transactional
    public List<String> change(String userId, String tag, boolean enabled, String actor) {
        if (tag == null || !tag.matches("[A-Z][A-Z0-9_]{0,31}") || (enabled && !KNOWN_TAGS.contains(tag))) {
            throw new BizException(OpsError.BAD_REQUEST);
        }
        if (tags.lockUser(userId) == null) throw new BizException(OpsError.NOT_FOUND);
        int changed = enabled ? tags.add(userId, tag, "运维台：" + actor) : tags.remove(userId, tag);
        log.info("Account tag changed actor={} userId={} tag={} enabled={} changed={}", actor, userId, tag, enabled, changed);
        return tags.list(userId);
    }
}
