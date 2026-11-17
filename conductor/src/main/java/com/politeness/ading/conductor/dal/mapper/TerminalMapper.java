package com.politeness.ading.conductor.dal.mapper;

import com.politeness.ading.conductor.dal.entity.TerminalEntity;
import java.util.List;
import org.apache.ibatis.annotations.Insert;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;
import org.apache.ibatis.annotations.Update;

@Mapper
public interface TerminalMapper {

    @Insert("""
            INSERT INTO terminals (terminal_id, name, type, fingerprint, status, owner)
            VALUES (#{terminalId}, #{name}, #{type}, #{fingerprint}, #{status}, #{owner})
            """)
    int insert(TerminalEntity terminal);

    @Select("SELECT * FROM terminals WHERE terminal_id = #{terminalId}")
    TerminalEntity findByTerminalId(@Param("terminalId") String terminalId);

    @Select("SELECT * FROM terminals WHERE owner = #{owner} AND fingerprint = #{fingerprint}")
    TerminalEntity findByOwnerAndFingerprint(@Param("owner") String owner,
                                            @Param("fingerprint") String fingerprint);

    @Select("SELECT * FROM terminals WHERE owner = #{owner} ORDER BY id")
    List<TerminalEntity> findByOwner(@Param("owner") String owner);

    /** Record that this account just connected or signed in on this device; the ops console uses it for account activity. Not a terminal profile change, so gmt_modified is untouched */
    @Update("""
            UPDATE terminals SET last_seen_at = #{at}, gmt_modified = gmt_modified
             WHERE terminal_id = #{terminalId} AND (last_seen_at IS NULL OR last_seen_at < #{at})
            """)
    int touchLastSeen(@Param("terminalId") String terminalId, @Param("at") java.time.LocalDateTime at);

    @Select("SELECT * FROM terminals WHERE status <> 'DISABLED' ORDER BY id")
    List<TerminalEntity> findForPresence();
}
